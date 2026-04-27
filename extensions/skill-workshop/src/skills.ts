import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isPathInside, isPathInsideWithRealpath } from "openclaw/plugin-sdk/security-runtime";
import {
  buildSyntheticWorkspaceSkillEntryForPreview,
  previewSkillsPromptImpact,
} from "openclaw/plugin-sdk/skills-runtime";
import { bumpSkillsSnapshotVersion } from "../api.js";
import { assertSkillContentSafe, scanSkillContent } from "./scanner.js";
import type { SkillProposal, SkillScanFinding } from "./types.js";

const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const VALID_SECTION = /^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,80}$/;
const SUPPORT_DIRS = new Set(["references", "templates", "scripts", "assets"]);

/**
 * `isPathInsideWithRealpath` needs a path that exists on disk. Walk up from `candidatePath`
 * until an existing path is found (stopping at `baseDir`), so first writes to new files still
 * validate symlink containment against the skill root.
 */
function resolveExistingPathForRealpathCheck(baseDir: string, candidatePath: string): string {
  const base = path.resolve(baseDir);
  let cur = path.resolve(candidatePath);
  if (!isPathInside(base, cur)) {
    throw new Error("path escapes base directory");
  }
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      return base;
    }
    if (!isPathInside(base, parent)) {
      throw new Error("path escapes base directory");
    }
    cur = parent;
  }
  return cur;
}

export function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 80);
}

export function assertValidSkillName(name: string): string {
  const normalized = normalizeSkillName(name);
  if (!VALID_SKILL_NAME.test(normalized)) {
    throw new Error(`invalid skill name: ${name}`);
  }
  return normalized;
}

function assertValidSection(section: string): string {
  const trimmed = section.trim();
  if (!VALID_SECTION.test(trimmed)) {
    throw new Error(`invalid section: ${section}`);
  }
  return trimmed;
}

function skillDir(workspaceDir: string, skillName: string): string {
  const safeName = assertValidSkillName(skillName);
  const ws = path.resolve(workspaceDir);
  const root = path.resolve(ws, "skills");
  const dir = path.resolve(root, safeName);
  if (!isPathInside(root, dir)) {
    throw new Error("skill path escapes workspace skills directory");
  }
  if (fs.existsSync(ws) && fs.existsSync(root)) {
    if (!isPathInsideWithRealpath(ws, root, { requireRealpath: true })) {
      throw new Error("workspace skills root resolves outside workspace");
    }
    if (fs.existsSync(dir) && !isPathInsideWithRealpath(root, dir, { requireRealpath: true })) {
      throw new Error("skill path escapes workspace skills directory after symlink resolution");
    }
  }
  return dir;
}

function skillPath(workspaceDir: string, skillName: string): string {
  const dir = skillDir(workspaceDir, skillName);
  const file = path.resolve(dir, "SKILL.md");
  if (!isPathInside(dir, file)) {
    throw new Error("SKILL.md path escapes skill directory");
  }
  if (fs.existsSync(dir)) {
    const realpathCandidate = resolveExistingPathForRealpathCheck(dir, file);
    if (!isPathInsideWithRealpath(dir, realpathCandidate, { requireRealpath: true })) {
      throw new Error("SKILL.md path escapes skill directory after symlink resolution");
    }
  }
  return file;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${randomUUID()}`;
  await fsPromises.writeFile(tempPath, content, "utf8");
  await fsPromises.rename(tempPath, filePath);
}

function formatSkillMarkdown(params: { name: string; description: string; body: string }): string {
  const description = params.description.replace(/\s+/g, " ").trim();
  if (!description) {
    throw new Error("description required");
  }
  const body = params.body.trim();
  return `---\nname: ${params.name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function ensureBodyUnderLimit(content: string, maxSkillBytes: number): void {
  if (Buffer.byteLength(content, "utf8") > maxSkillBytes) {
    throw new Error(`skill exceeds ${maxSkillBytes} bytes`);
  }
}

function appendSection(markdown: string, section: string, body: string): string {
  const heading = `## ${assertValidSection(section)}`;
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    throw new Error("body required");
  }
  if (markdown.includes(trimmedBody)) {
    return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  }
  if (!markdown.includes(heading)) {
    return `${markdown.trimEnd()}\n\n${heading}\n\n${trimmedBody}\n`;
  }
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.replace(new RegExp(`(${escaped}\\n)`), `$1\n${trimmedBody}\n`);
}

/**
 * Enforces the same workspace skills prompt budget semantics as core (`previewSkillsPromptImpact`).
 * Skips when `openClawConfig` is omitted (callers should pass `api.config` when available).
 */
export function enforceSkillsPromptBudgetIfConfigured(params: {
  proposal: SkillProposal;
  preparedMarkdown: string;
  created: boolean;
  openClawConfig?: OpenClawConfig;
}): void {
  if (params.openClawConfig === undefined) {
    return;
  }
  const synthetic = buildSyntheticWorkspaceSkillEntryForPreview({
    workspaceDir: params.proposal.workspaceDir,
    skillName: params.proposal.skillName,
    markdownContent: params.preparedMarkdown,
  });
  const preview = previewSkillsPromptImpact({
    workspaceDir: params.proposal.workspaceDir,
    config: params.openClawConfig,
    agentId: params.proposal.agentId,
    simulationMode: params.created ? "propose" : "replace",
    syntheticEntry: synthetic,
  });
  if (!preview.withinLimits) {
    throw new Error("skill would exceed workspace skills prompt budget");
  }
}

export async function prepareProposalWrite(params: {
  proposal: SkillProposal;
  maxSkillBytes: number;
}): Promise<{
  skillPath: string;
  content: string;
  created: boolean;
  findings: SkillScanFinding[];
}> {
  const name = assertValidSkillName(params.proposal.skillName);
  const target = skillPath(params.proposal.workspaceDir, name);
  const exists = await pathExists(target);
  let next: string;
  const change = params.proposal.change;
  if (change.kind === "create") {
    next = exists
      ? appendSection(await fsPromises.readFile(target, "utf8"), "Workflow", change.body)
      : formatSkillMarkdown({ name, description: change.description, body: change.body });
  } else if (change.kind === "append") {
    const current = exists
      ? await fsPromises.readFile(target, "utf8")
      : formatSkillMarkdown({
          name,
          description: change.description ?? params.proposal.title,
          body: "# Workflow\n",
        });
    next = appendSection(current, change.section, change.body);
  } else {
    if (!exists) {
      throw new Error(`skill does not exist: ${name}`);
    }
    const current = await fsPromises.readFile(target, "utf8");
    if (!current.includes(change.oldText)) {
      throw new Error("oldText not found");
    }
    next = current.replace(change.oldText, change.newText);
  }
  ensureBodyUnderLimit(next, params.maxSkillBytes);
  const findings = scanSkillContent(next);
  return { skillPath: target, content: next, created: !exists, findings };
}

export async function applyProposalToWorkspace(params: {
  proposal: SkillProposal;
  maxSkillBytes: number;
  openClawConfig?: OpenClawConfig;
}): Promise<{ skillPath: string; created: boolean; findings: SkillScanFinding[] }> {
  const prepared = await prepareProposalWrite(params);
  assertSkillContentSafe(prepared.content);
  enforceSkillsPromptBudgetIfConfigured({
    proposal: params.proposal,
    preparedMarkdown: prepared.content,
    created: prepared.created,
    openClawConfig: params.openClawConfig,
  });
  const verified = await prepareProposalWrite(params);
  if (verified.skillPath !== prepared.skillPath || verified.content !== prepared.content) {
    throw new Error("skill proposal stale: workspace changed before write");
  }
  await atomicWrite(verified.skillPath, verified.content);
  bumpSkillsSnapshotVersion({
    workspaceDir: params.proposal.workspaceDir,
    reason: "manual",
    changedPath: verified.skillPath,
  });
  return { skillPath: verified.skillPath, created: verified.created, findings: verified.findings };
}

export async function writeSupportFile(params: {
  workspaceDir: string;
  skillName: string;
  relativePath: string;
  content: string;
  maxBytes: number;
}): Promise<string> {
  const name = assertValidSkillName(params.skillName);
  const parts = params.relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || !SUPPORT_DIRS.has(parts[0])) {
    throw new Error(`support file path must start with ${Array.from(SUPPORT_DIRS).join(", ")}`);
  }
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("support file path escapes skill directory");
  }
  if (Buffer.byteLength(params.content, "utf8") > params.maxBytes) {
    throw new Error(`support file exceeds ${params.maxBytes} bytes`);
  }
  assertSkillContentSafe(params.content);
  const root = skillDir(params.workspaceDir, name);
  const target = path.resolve(root, ...parts);
  if (!isPathInside(root, target)) {
    throw new Error("support file path escapes skill directory");
  }
  if (fs.existsSync(root)) {
    const realpathCandidate = resolveExistingPathForRealpathCheck(root, target);
    if (!isPathInsideWithRealpath(root, realpathCandidate, { requireRealpath: true })) {
      throw new Error("support file path escapes skill directory after symlink resolution");
    }
  }
  await atomicWrite(target, `${params.content.trimEnd()}\n`);
  return target;
}
