import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { isPathInside } from "../../infra/path-guards.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  buildWorkspaceSkillsPrompt,
  loadWorkspaceSkillEntries,
  resolveSkillsLimits,
} from "./workspace.js";

export type SkillsManageTargetRoot = "workspace" | "project-agents";

export type SkillProposal = {
  id: string;
  name: string;
  targetRoot: SkillsManageTargetRoot;
  skillDir: string;
  skillMdPath: string;
  contents: string;
  createdAt: number;
  createdBySessionKey?: string;
};

const proposals = new Map<string, SkillProposal>();

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

export function detectSecrets(text: string): { ok: boolean; matches?: string[] } {
  const redacted = redactSensitiveText(text);
  if (redacted === text) {
    return { ok: true };
  }
  return { ok: false, matches: ["redact-sensitive-pattern"] };
}

export function createProposal(params: {
  workspaceDir: string;
  targetRoot?: SkillsManageTargetRoot;
  name: string;
  contents: string;
  createdBySessionKey?: string;
}): { ok: true; proposal: SkillProposal } | { ok: false; error: string } {
  const validated = validateSkillName(params.name);
  if (!validated.ok || !validated.normalized) {
    return { ok: false, error: validated.error ?? "invalid name" };
  }
  const target = resolveSkillRoot(params.workspaceDir, params.targetRoot ?? "workspace");
  const skillDir = path.resolve(target.rootPath, validated.normalized);
  const skillMdPath = path.resolve(skillDir, "SKILL.md");
  if (!isPathInside(target.rootPath, skillDir) || !isPathInside(target.rootPath, skillMdPath)) {
    return { ok: false, error: "resolved path escapes skills root" };
  }

  const proposal: SkillProposal = {
    id: randomUUID(),
    name: validated.normalized,
    targetRoot: target.kind,
    skillDir,
    skillMdPath,
    contents: params.contents,
    createdAt: Date.now(),
    createdBySessionKey: params.createdBySessionKey,
  };
  proposals.set(proposal.id, proposal);
  return { ok: true, proposal };
}

export function getProposal(id: string): SkillProposal | undefined {
  return proposals.get(id);
}

export function listProposals(sessionKey?: string): SkillProposal[] {
  const items = Array.from(proposals.values()).sort((a, b) => b.createdAt - a.createdAt);
  if (!sessionKey) {
    return items;
  }
  return items.filter((proposal) => proposal.createdBySessionKey === sessionKey);
}

export function deleteProposal(id: string): boolean {
  return proposals.delete(id);
}

export function clearProposalsForTests(): void {
  proposals.clear();
}

export function setProposalForTests(proposal: SkillProposal): void {
  proposals.set(proposal.id, proposal);
}

export function projectSkillsManageBudget(params: {
  workspaceDir: string;
  contents: string;
  config?: OpenClawConfig;
}): { ok: boolean; error?: string } {
  const limits = resolveSkillsLimits(params.config);
  const entries = loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config });
  const activeSkillCount = entries.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  ).length;
  if (activeSkillCount + 1 > limits.maxSkillsInPrompt) {
    return {
      ok: false,
      error: `proposal would exceed maxSkillsInPrompt (${limits.maxSkillsInPrompt}) and trigger truncation`,
    };
  }

  const existingPrompt = buildWorkspaceSkillsPrompt(params.workspaceDir, { config: params.config });
  if (existingPrompt.length + params.contents.length > limits.maxSkillsPromptChars) {
    return {
      ok: false,
      error: `proposal would exceed maxSkillsPromptChars (${limits.maxSkillsPromptChars}) and trigger truncation`,
    };
  }
  return { ok: true };
}
