import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { detectSensitivePatterns } from "../../logging/redact.js";
import { createSyntheticSourceInfo, type Skill } from "./skill-contract.js";
import type { SkillEntry } from "./types.js";
import { previewSkillsPromptImpact, resolveSkillsLimits } from "./workspace.js";

export type SkillsManageTargetRoot = "workspace" | "project-agents";

export type SkillManageTriggerReason =
  | "complex_success"
  | "error_recovery"
  | "user_requested_memory"
  | "skill_maintenance";

export type SkillManageProposalKind = "new" | "update" | "patch";

export type SkillPatchIntent = {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  baseSkillHash: string;
};

export type SkillManageProposal = {
  id: string;
  kind: SkillManageProposalKind;
  name: string;
  targetRoot: SkillsManageTargetRoot;
  skillDir: string;
  skillMdPath: string;
  /** Resolved body for new/update; for patch, preview-only at creation may be empty */
  contents: string;
  patch?: SkillPatchIntent;
  createdAt: number;
  lastTouchedAt: number;
  sourceSessionKey?: string;
  triggerReason?: SkillManageTriggerReason;
};

export type SkillQualityRubric = {
  score: number;
  missingSections: string[];
  warnings: string[];
  policyRuleIds: string[];
};

const proposals = new Map<string, SkillManageProposal>();

const DEFAULT_PROPOSAL_TTL_MS = 86_400_000;
const DEFAULT_MAX_PENDING = 50;

type SessionAutoState = { count: number; lastProposalAt: number };
const sessionAutoProposeState = new Map<string, SessionAutoState>();

export function __resetSkillsManageProposalsForTests(): void {
  proposals.clear();
  sessionAutoProposeState.clear();
}

export function resolveSkillsManageRuntime(config?: OpenClawConfig): {
  enabled: boolean;
  proposalTtlMs: number;
  maxPendingProposals: number;
  autoPropose: {
    enabled: boolean;
    maxPerSession: number;
    cooldownMs: number;
    minToolCalls: number;
  };
} {
  const manage = config?.skills?.manage;
  const auto = manage?.autoPropose;
  return {
    enabled: manage?.enabled !== false,
    proposalTtlMs: manage?.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS,
    maxPendingProposals: manage?.maxPendingProposals ?? DEFAULT_MAX_PENDING,
    autoPropose: {
      enabled: auto?.enabled === true,
      maxPerSession: auto?.maxPerSession ?? 1,
      cooldownMs: (auto?.cooldownMinutes ?? 30) * 60_000,
      minToolCalls: auto?.minToolCalls ?? 5,
    },
  };
}

export function resolveSkillRoot(
  workspaceDir: string,
  kind: SkillsManageTargetRoot,
): { kind: SkillsManageTargetRoot; rootPath: string } {
  if (kind === "project-agents") {
    return {
      kind,
      rootPath: path.resolve(workspaceDir, ".agents", "skills"),
    };
  }
  return {
    kind: "workspace",
    rootPath: path.resolve(workspaceDir, "skills"),
  };
}

export function validateSkillName(name: string): {
  ok: boolean;
  normalized?: string;
  error?: string;
} {
  const raw = name.trim();
  if (!raw) {
    return { ok: false, error: "name is required" };
  }
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    return { ok: false, error: "name cannot contain path separators or '..'" };
  }
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return { ok: false, error: "name must include alphanumeric characters" };
  }
  return { ok: true, normalized };
}

function normalizeHeadingKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SECTION_CHECKS: Array<{ id: string; aliases: string[] }> = [
  { id: "purpose_when", aliases: ["purpose", "when to use", "use when"] },
  { id: "inputs", aliases: ["inputs", "prerequisites", "requirements"] },
  { id: "procedure", aliases: ["procedure", "steps", "instructions"] },
  { id: "verification", aliases: ["verification", "validation", "success checks"] },
  { id: "pitfalls", aliases: ["pitfalls", "failure recovery", "troubleshooting"] },
  { id: "safety", aliases: ["safety constraints", "safety", "constraints"] },
];

function extractHeadingBodies(content: string): string[] {
  const bodies: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+)\s*$/);
    if (m?.[1]) {
      bodies.push(normalizeHeadingKey(m[1]));
    }
  }
  return bodies;
}

function headingMatchesAny(bodyNorm: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const a = normalizeHeadingKey(alias);
    return (
      bodyNorm === a || bodyNorm.includes(a) || a.split(/\s+/).every((w) => bodyNorm.includes(w))
    );
  });
}

export function validateSkillQuality(content: string): {
  ok: boolean;
  errorCode?: "quality_incomplete" | "quality_low_signal" | "quality_too_verbose";
  missingSections: string[];
  score: number;
  warnings: string[];
  policyRuleIds: string[];
} {
  const headings = extractHeadingBodies(content);
  const missingSections: string[] = [];
  let score = 0;
  for (const section of SECTION_CHECKS) {
    const hit = headings.some((h) => headingMatchesAny(h, section.aliases));
    if (hit) {
      score += 1;
    } else {
      missingSections.push(section.id);
    }
  }
  const hasNumberedSteps = /(^|\n)\s*\d+\.\s+\S/m.test(content);
  if (hasNumberedSteps) {
    score += 1;
  }
  const lower = content.toLowerCase();
  if (/\b(verify|expect|check|confirm)\b/.test(lower)) {
    score += 1;
  }
  if (/\b(pitfall|mistake|recover|rollback)\b/.test(lower)) {
    score += 1;
  }
  if (/\b(do not|never run|destructive|requires approval)\b/.test(lower)) {
    score += 1;
  }
  if (/\b(when to use|use this skill|use when)\b/.test(lower)) {
    score += 1;
  }
  if (/\b(do not use for|not for|avoid using)\b/.test(lower)) {
    score += 1;
  }

  const warnings: string[] = [];
  if (!hasNumberedSteps) {
    warnings.push("procedure_not_numbered");
  }
  if (!/\b(verify|expect|check)\b/.test(lower)) {
    warnings.push("weak_verification_language");
  }
  if (content.length > 24_000) {
    return {
      ok: false,
      errorCode: "quality_too_verbose",
      missingSections,
      score,
      warnings,
      policyRuleIds: [],
    };
  }

  if (missingSections.length > 0) {
    return {
      ok: false,
      errorCode: "quality_incomplete",
      missingSections,
      score,
      warnings,
      policyRuleIds: [],
    };
  }
  if (score < 8) {
    return {
      ok: false,
      errorCode: "quality_low_signal",
      missingSections: [],
      score,
      warnings,
      policyRuleIds: [],
    };
  }
  if (score < 10) {
    warnings.push("quality_marginal_score");
  }
  return { ok: true, missingSections: [], score, warnings, policyRuleIds: [] };
}

export function hashSkillFileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function tryApplyPatch(params: {
  base: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): { ok: true; next: string } | { ok: false; errorCode: "patch_no_match" | "patch_ambiguous" } {
  const { base, oldString, newString, replaceAll } = params;
  if (!oldString) {
    return { ok: false, errorCode: "patch_no_match" };
  }
  const count = base.split(oldString).length - 1;
  if (count === 0) {
    return { ok: false, errorCode: "patch_no_match" };
  }
  if (!replaceAll && count > 1) {
    return { ok: false, errorCode: "patch_ambiguous" };
  }
  if (replaceAll) {
    return { ok: true, next: base.split(oldString).join(newString) };
  }
  const idx = base.indexOf(oldString);
  return { ok: true, next: base.slice(0, idx) + newString + base.slice(idx + oldString.length) };
}

function sweepExpired(ttlMs: number): void {
  const now = Date.now();
  for (const [id, p] of proposals) {
    if (now - p.createdAt > ttlMs) {
      proposals.delete(id);
    }
  }
}

function countPendingForSession(sessionKey: string | undefined): number {
  if (!sessionKey) {
    return proposals.size;
  }
  let n = 0;
  for (const p of proposals.values()) {
    if (p.sourceSessionKey === sessionKey) {
      n += 1;
    }
  }
  return n;
}

function syntheticSkillEntryForBudget(
  workspaceDir: string,
  name: string,
  description: string,
  targetRoot: SkillsManageTargetRoot,
): SkillEntry {
  const root = resolveSkillRoot(workspaceDir, targetRoot);
  const skillDir = path.join(root.rootPath, name);
  const filePath = path.join(skillDir, "SKILL.md");
  const skill: Skill = {
    name,
    description,
    filePath,
    baseDir: skillDir,
    source: "workspace",
    disableModelInvocation: false,
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: "workspace",
      baseDir: skillDir,
      scope: "project",
      origin: "top-level",
    }),
  };
  return {
    skill,
    frontmatter: { name, description },
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: true,
      userInvocable: true,
    },
  };
}

export function checkBudgetPreview(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  mode: "propose" | "replace";
  skillName: string;
  descriptionForPrompt: string;
  targetRoot: SkillsManageTargetRoot;
}): { withinLimits: boolean; compact: boolean; truncated: boolean } {
  return previewSkillsPromptImpact({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    simulationMode: params.mode,
    syntheticEntry: syntheticSkillEntryForBudget(
      params.workspaceDir,
      params.skillName,
      params.descriptionForPrompt,
      params.targetRoot,
    ),
  });
}

export async function readSkillMdFromDisk(
  workspaceDir: string,
  name: string,
  targetRoot: SkillsManageTargetRoot,
): Promise<
  { ok: true; path: string; content: string } | { ok: false; errorCode: "skill_not_found" }
> {
  const validated = validateSkillName(name);
  if (!validated.ok || !validated.normalized) {
    return { ok: false, errorCode: "skill_not_found" };
  }
  const root = resolveSkillRoot(workspaceDir, targetRoot);
  const skillMdPath = path.resolve(root.rootPath, validated.normalized, "SKILL.md");
  if (!isPathInside(root.rootPath, skillMdPath)) {
    return { ok: false, errorCode: "skill_not_found" };
  }
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    return { ok: true, path: skillMdPath, content };
  } catch {
    return { ok: false, errorCode: "skill_not_found" };
  }
}

export function createProposal(params: {
  workspaceDir: string;
  targetRoot?: SkillsManageTargetRoot;
  name: string;
  contents: string;
  kind: SkillManageProposalKind;
  patch?: SkillPatchIntent;
  sourceSessionKey?: string;
  triggerReason?: SkillManageTriggerReason;
  config?: OpenClawConfig;
  agentId?: string;
}):
  | {
      ok: true;
      proposal: SkillManageProposal;
      quality: SkillQualityRubric;
      budgetPreview: {
        withinLimits: boolean;
        compact: boolean;
        truncated: boolean;
      };
    }
  | { ok: false; errorCode: string; error: string; hint?: string } {
  const runtime = resolveSkillsManageRuntime(params.config);
  sweepExpired(runtime.proposalTtlMs);
  if (proposals.size >= runtime.maxPendingProposals) {
    return {
      ok: false,
      errorCode: "proposal_limit_reached",
      error: "Too many pending proposals",
      hint: "Delete stale proposals or wait for TTL expiry, then retry.",
    };
  }
  if (countPendingForSession(params.sourceSessionKey) >= runtime.maxPendingProposals) {
    return {
      ok: false,
      errorCode: "proposal_limit_reached",
      error: "Session pending proposal limit reached",
      hint: "Delete stale proposals or wait for TTL expiry, then retry.",
    };
  }

  const validated = validateSkillName(params.name);
  if (!validated.ok || !validated.normalized) {
    return { ok: false, errorCode: "missing_argument", error: validated.error ?? "invalid name" };
  }
  const target = resolveSkillRoot(params.workspaceDir, params.targetRoot ?? "workspace");
  const skillDir = path.resolve(target.rootPath, validated.normalized);
  const skillMdPath = path.resolve(skillDir, "SKILL.md");
  if (!isPathInside(target.rootPath, skillDir) || !isPathInside(target.rootPath, skillMdPath)) {
    return {
      ok: false,
      errorCode: "path_violation",
      error: "resolved path escapes skills root",
      hint: "Pick a different targetRoot or skill name.",
    };
  }

  if (params.kind === "new" && fsSync.existsSync(skillMdPath)) {
    return {
      ok: false,
      errorCode: "name_conflict",
      error: "A skill with this name already exists on disk",
      hint: "Pick a different name or use update/patch to revise the existing skill.",
    };
  }

  const limits = resolveSkillsLimits(params.config, params.agentId);
  const bytes = Buffer.byteLength(params.contents, "utf8");
  const qualityGate = validateSkillQuality(params.contents);
  if (!qualityGate.ok) {
    return {
      ok: false,
      errorCode: qualityGate.errorCode ?? "quality_incomplete",
      error:
        qualityGate.errorCode === "quality_too_verbose"
          ? "Skill draft is too verbose for v1 limits; compress prose and keep procedure plus verification."
          : "Skill draft failed quality gate",
      hint:
        qualityGate.errorCode === "quality_incomplete"
          ? `Add missing sections: ${qualityGate.missingSections.join(", ")}`
          : "Improve structure, triggers, and verification language, then retry propose.",
    };
  }

  const secret = detectSensitivePatterns(params.contents);
  if (secret.blocked) {
    return {
      ok: false,
      errorCode: "secret_detected",
      error: "Proposal rejected: sensitive pattern detected",
      hint: "Remove secrets and retry.",
    };
  }
  if (bytes > limits.maxSkillFileBytes) {
    return {
      ok: false,
      errorCode: "content_too_large",
      error: `skill file too large (${bytes} > ${limits.maxSkillFileBytes} bytes)`,
    };
  }

  const previewDesc =
    params.contents
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.slice(0, 200) ?? params.name;
  const budgetPreview = checkBudgetPreview({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    mode: params.kind === "new" ? "propose" : "replace",
    skillName: validated.normalized,
    descriptionForPrompt: previewDesc,
    targetRoot: target.kind,
  });
  if (!budgetPreview.withinLimits) {
    return {
      ok: false,
      errorCode: "budget_exceeded",
      error: "Proposal would exceed skills prompt budget",
      hint: "Reduce skills in workspace or raise skills.limits budgets.",
    };
  }

  const now = Date.now();
  const proposal: SkillManageProposal = {
    id: `sp_${randomUUID()}`,
    kind: params.kind,
    name: validated.normalized,
    targetRoot: target.kind,
    skillDir,
    skillMdPath,
    contents: params.contents,
    patch: params.patch,
    createdAt: now,
    lastTouchedAt: now,
    sourceSessionKey: params.sourceSessionKey,
    triggerReason: params.triggerReason,
  };
  proposals.set(proposal.id, proposal);
  return {
    ok: true,
    proposal,
    quality: {
      score: qualityGate.score,
      missingSections: qualityGate.missingSections,
      warnings: qualityGate.warnings,
      policyRuleIds: secret.ruleIds,
    },
    budgetPreview,
  };
}

export function getProposal(id: string, config?: OpenClawConfig): SkillManageProposal | undefined {
  const runtime = resolveSkillsManageRuntime(config);
  sweepExpired(runtime.proposalTtlMs);
  return proposals.get(id);
}

export function listProposals(sessionKey?: string, config?: OpenClawConfig): SkillManageProposal[] {
  const runtime = resolveSkillsManageRuntime(config);
  sweepExpired(runtime.proposalTtlMs);
  const items = Array.from(proposals.values()).sort((a, b) => b.createdAt - a.createdAt);
  if (!sessionKey) {
    return items;
  }
  return items.filter((p) => p.sourceSessionKey === sessionKey);
}

export function deleteProposal(id: string): boolean {
  return proposals.delete(id);
}

async function mkdirSegmentWalk(
  resolvedAllowedRoot: string,
  relParts: string[],
): Promise<{ ok: true; resolvedSkillDir: string } | { ok: false; error: string }> {
  let resolvedSkillDir = resolvedAllowedRoot;
  try {
    for (const part of relParts) {
      const nextPath = path.join(resolvedSkillDir, part);
      const st = await fs.lstat(nextPath).catch(() => null);
      if (!st) {
        await fs.mkdir(nextPath);
      } else if (!st.isDirectory() && !st.isSymbolicLink()) {
        return { ok: false, error: "skill path blocked by a non-directory file" };
      }
      const resolvedNext = await fs.realpath(nextPath);
      if (!isPathInside(resolvedAllowedRoot, resolvedNext)) {
        return {
          ok: false,
          error: "proposal path escapes allowed skill roots after symlink resolution",
        };
      }
      resolvedSkillDir = resolvedNext;
    }
  } catch {
    return { ok: false, error: "could not resolve proposal paths after mkdir" };
  }
  return { ok: true, resolvedSkillDir };
}

export async function approveProposal(params: {
  proposalId: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<
  | {
      ok: true;
      path: string;
      appliedChecks: string[];
    }
  | { ok: false; errorCode: string; error: string; hint?: string }
> {
  const runtime = resolveSkillsManageRuntime(params.config);
  sweepExpired(runtime.proposalTtlMs);
  const proposal = proposals.get(params.proposalId);
  if (!proposal) {
    return {
      ok: false,
      errorCode: "proposal_not_found",
      error: "proposal not found",
      hint: "Call list, then retry with a valid proposalId.",
    };
  }
  const appliedChecks: string[] = [];
  const targetRoot = resolveSkillRoot(params.workspaceDir, proposal.targetRoot);
  if (
    !isPathInside(targetRoot.rootPath, proposal.skillDir) ||
    !isPathInside(targetRoot.rootPath, proposal.skillMdPath)
  ) {
    return {
      ok: false,
      errorCode: "path_violation",
      error: "proposal path is outside allowed skill roots",
    };
  }
  appliedChecks.push("containment");

  let body: string;
  if (proposal.kind === "patch") {
    if (!proposal.patch) {
      return {
        ok: false,
        errorCode: "invalid_action_arguments",
        error: "patch proposal missing patch intent",
      };
    }
    const disk = await readSkillMdFromDisk(params.workspaceDir, proposal.name, proposal.targetRoot);
    if (!disk.ok) {
      return { ok: false, errorCode: "skill_not_found", error: "skill not found on disk" };
    }
    const currentHash = hashSkillFileContent(disk.content);
    if (currentHash !== proposal.patch.baseSkillHash) {
      return {
        ok: false,
        errorCode: "patch_base_stale",
        error: "SKILL.md changed since patch proposal was created",
        hint: "Re-run patch against current on-disk SKILL.md, then approve the new proposal.",
      };
    }
    const applied = tryApplyPatch({
      base: disk.content,
      oldString: proposal.patch.oldString,
      newString: proposal.patch.newString,
      replaceAll: proposal.patch.replaceAll,
    });
    if (!applied.ok) {
      return {
        ok: false,
        errorCode: applied.errorCode,
        error:
          applied.errorCode === "patch_no_match"
            ? "oldString not found"
            : "oldString matched multiple times",
      };
    }
    body = applied.next;
  } else {
    body = proposal.contents;
  }

  const limits = resolveSkillsLimits(params.config, params.agentId);
  const sizeBytes = Buffer.byteLength(body, "utf8");
  if (sizeBytes > limits.maxSkillFileBytes) {
    return {
      ok: false,
      errorCode: "content_too_large",
      error: `skill file too large (${sizeBytes} bytes)`,
    };
  }
  const secretCheck = detectSensitivePatterns(body);
  if (secretCheck.blocked) {
    return {
      ok: false,
      errorCode: "secret_detected",
      error: "proposal rejected: detected sensitive content",
    };
  }
  appliedChecks.push("secrets", "size");

  const budget = checkBudgetPreview({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    mode: "replace",
    skillName: proposal.name,
    descriptionForPrompt:
      body
        .split("\n")
        .find((l) => l.trim())
        ?.slice(0, 200) ?? proposal.name,
    targetRoot: proposal.targetRoot,
  });
  if (!budget.withinLimits) {
    return {
      ok: false,
      errorCode: "budget_exceeded",
      error: "Approve would exceed skills prompt budget",
    };
  }
  appliedChecks.push("budget");

  const q = validateSkillQuality(body);
  if (!q.ok) {
    return {
      ok: false,
      errorCode: q.errorCode ?? "quality_incomplete",
      error: "Approved content failed quality revalidation",
      hint: "Fix SKILL.md structure, then create a new proposal.",
    };
  }
  appliedChecks.push("quality");

  await fs.mkdir(targetRoot.rootPath, { recursive: true });
  let resolvedAllowedRoot: string;
  try {
    resolvedAllowedRoot = await fs.realpath(targetRoot.rootPath);
  } catch {
    return { ok: false, errorCode: "path_violation", error: "could not resolve skill root path" };
  }
  const relSkillDir = path.relative(targetRoot.rootPath, proposal.skillDir);
  if (!relSkillDir || relSkillDir.startsWith("..") || path.isAbsolute(relSkillDir)) {
    return {
      ok: false,
      errorCode: "path_violation",
      error: "proposal path is outside allowed skill roots",
    };
  }
  const relParts = path.normalize(relSkillDir).split(path.sep).filter(Boolean);
  const walked = await mkdirSegmentWalk(resolvedAllowedRoot, relParts);
  if (!walked.ok) {
    return { ok: false, errorCode: "path_violation", error: walked.error };
  }
  const resolvedSkillMdPath = path.join(
    walked.resolvedSkillDir,
    path.basename(proposal.skillMdPath),
  );
  // Final path may not exist yet; lexical containment under the resolved skill dir is sufficient here.
  if (!isPathInside(resolvedAllowedRoot, resolvedSkillMdPath)) {
    return {
      ok: false,
      errorCode: "path_violation",
      error: "SKILL.md path failed containment check",
    };
  }
  if (!isPathInside(walked.resolvedSkillDir, resolvedSkillMdPath)) {
    return {
      ok: false,
      errorCode: "path_violation",
      error: "SKILL.md path escapes skill directory",
    };
  }
  const mdStat = await fs.lstat(resolvedSkillMdPath).catch(() => null);
  if (proposal.kind === "new" && mdStat) {
    return {
      ok: false,
      errorCode: "name_conflict",
      error: "A skill with this name already exists on disk",
      hint: "Use update/patch to revise the existing skill, or choose a new skill name.",
    };
  }
  if (mdStat?.isSymbolicLink()) {
    let realMd: string;
    try {
      realMd = await fs.realpath(resolvedSkillMdPath);
    } catch {
      return { ok: false, errorCode: "path_violation", error: "could not resolve SKILL.md path" };
    }
    if (!isPathInside(resolvedAllowedRoot, realMd)) {
      return { ok: false, errorCode: "path_violation", error: "SKILL.md symlink escapes root" };
    }
  }
  await fs.writeFile(resolvedSkillMdPath, body, "utf8");
  proposals.delete(params.proposalId);
  return { ok: true, path: resolvedSkillMdPath, appliedChecks };
}

export function maybeAutoProposeSkillAfterRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  toolCallCount: number;
  runSucceeded: boolean;
  runFailed: boolean;
  loadedSkillNames: string[];
}): { attempted: boolean; skipReason?: string } {
  const rt = resolveSkillsManageRuntime(params.config);
  if (!rt.enabled || !rt.autoPropose.enabled) {
    return { attempted: false, skipReason: "disabled" };
  }
  if (params.toolCallCount < rt.autoPropose.minToolCalls) {
    return { attempted: false, skipReason: "below_min_tool_calls" };
  }
  const key = params.sessionKey ?? "_global";
  const st = sessionAutoProposeState.get(key) ?? { count: 0, lastProposalAt: 0 };
  const now = Date.now();
  if (st.count >= rt.autoPropose.maxPerSession) {
    return { attempted: false, skipReason: "session_cap" };
  }
  if (now - st.lastProposalAt < rt.autoPropose.cooldownMs) {
    return { attempted: false, skipReason: "cooldown" };
  }

  let trigger: SkillManageTriggerReason | undefined;
  if (params.runSucceeded) {
    trigger = "complex_success";
  } else if (params.runFailed && params.loadedSkillNames.length > 0) {
    trigger = "skill_maintenance";
  } else if (params.runFailed) {
    trigger = "error_recovery";
  } else {
    return { attempted: false, skipReason: "no_trigger" };
  }

  const draftName = `auto-draft-${Date.now().toString(36)}`;
  const lines = [
    "## Purpose / When to use",
    "Auto-drafted from a completed multi-tool run. Review and edit before approve.",
    "## Inputs / prerequisites",
    "Operator review required.",
    "## Procedure",
    "1. Read this draft.",
    "2. Edit sections to match your workflow.",
    "## Verification",
    "Confirm SKILL.md matches intended behavior.",
    "## Pitfalls / failure recovery",
    "Do not approve without human review.",
    "## Safety constraints",
    "Do not use for destructive operations without explicit approval.",
    "## When to use",
    "Use after validating the draft fits your environment.",
    "## Do not use for",
    "One-off tasks that should not become skills.",
  ];
  const body = lines.join("\n");
  const created = createProposal({
    workspaceDir: params.workspaceDir,
    name: draftName,
    contents: body,
    kind: "new",
    sourceSessionKey: params.sessionKey,
    triggerReason: trigger,
    config: params.config,
    agentId: params.agentId,
  });
  if (!created.ok) {
    return { attempted: false, skipReason: "quality_gate_failed" };
  }
  st.count += 1;
  st.lastProposalAt = now;
  sessionAutoProposeState.set(key, st);
  return { attempted: true };
}
