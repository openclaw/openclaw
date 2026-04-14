import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir } from "../config/paths.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { shortenHomePath } from "../utils.js";

const execFileAsync = promisify(execFile);
const REPO_SLOTS_DIRNAME = "repo-slots";
const SLOT_METADATA_FILENAME = "slot.json";

type GitResult = { stdout: string; stderr: string };

export type RepoSlotMaterialization = "worktree" | "clone";

export type RepoSlotRecord = {
  version: 1;
  slot: string;
  repoRoot: string;
  repoName: string;
  repoKey: string;
  originUrl?: string;
  createdAt: string;
  updatedAt: string;
  materialization: RepoSlotMaterialization;
  workspaceDir: string;
  headSha?: string;
  baseRef?: string;
};

export type EnsureRepoSlotResult = {
  created: boolean;
  record: RepoSlotRecord;
};

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  return await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function tryRunGit(args: string[], cwd?: string): Promise<GitResult | null> {
  try {
    return await runGit(args, cwd);
  } catch {
    return null;
  }
}

export async function resolveGitRepoRoot(inputPath: string): Promise<string> {
  const resolvedInput = path.resolve(inputPath);
  const { stdout } = await runGit(["-C", resolvedInput, "rev-parse", "--show-toplevel"]);
  return path.resolve(stdout.trim());
}

async function readOriginUrl(repoRoot: string): Promise<string | undefined> {
  const result = await tryRunGit(["-C", repoRoot, "remote", "get-url", "origin"]);
  const value = normalizeOptionalString(result?.stdout);
  return value || undefined;
}

async function readHeadSha(repoRoot: string): Promise<string | undefined> {
  const result = await tryRunGit(["-C", repoRoot, "rev-parse", "HEAD"]);
  const value = normalizeOptionalString(result?.stdout);
  return value || undefined;
}

function buildRepoKey(repoRoot: string, originUrl?: string): { repoName: string; repoKey: string } {
  const repoName = sanitizeSegment(path.basename(repoRoot), "repo");
  const hashInput = `${repoRoot}\n${originUrl ?? ""}`;
  const hash = crypto.createHash("sha1").update(hashInput).digest("hex").slice(0, 10);
  return { repoName, repoKey: `${repoName}-${hash}` };
}

export function resolveRepoSlotsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), REPO_SLOTS_DIRNAME);
}

export function resolveRepoSlotPaths(params: {
  repoRoot: string;
  originUrl?: string;
  slot: string;
  env?: NodeJS.ProcessEnv;
}) {
  const normalizedSlot = sanitizeSegment(params.slot, "slot");
  const { repoName, repoKey } = buildRepoKey(params.repoRoot, params.originUrl);
  const repoDir = path.join(resolveRepoSlotsRoot(params.env), repoKey);
  const slotDir = path.join(repoDir, normalizedSlot);
  const workspaceDir = path.join(slotDir, "repo");
  const metadataPath = path.join(slotDir, SLOT_METADATA_FILENAME);
  return { normalizedSlot, repoName, repoKey, repoDir, slotDir, workspaceDir, metadataPath };
}

async function readSlotRecord(metadataPath: string): Promise<RepoSlotRecord | null> {
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as RepoSlotRecord;
  } catch {
    return null;
  }
}

async function writeSlotRecord(record: RepoSlotRecord, metadataPath: string) {
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function materializeWorktree(params: {
  repoRoot: string;
  workspaceDir: string;
  baseRef: string;
}): Promise<RepoSlotMaterialization> {
  await fs.mkdir(path.dirname(params.workspaceDir), { recursive: true });
  try {
    await runGit(
      ["-C", params.repoRoot, "worktree", "add", "--detach", params.workspaceDir, params.baseRef],
      params.repoRoot,
    );
    return "worktree";
  } catch {
    await runGit(["clone", "--no-checkout", params.repoRoot, params.workspaceDir]);
    await runGit(["-C", params.workspaceDir, "checkout", "--detach", params.baseRef]);
    return "clone";
  }
}

export async function ensureRepoSlot(params: {
  repoPath: string;
  slot: string;
  baseRef?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<EnsureRepoSlotResult> {
  const repoRoot = await resolveGitRepoRoot(params.repoPath);
  const originUrl = await readOriginUrl(repoRoot);
  const headSha = await readHeadSha(repoRoot);
  const baseRef = normalizeOptionalString(params.baseRef) || headSha || "HEAD";
  const paths = resolveRepoSlotPaths({ repoRoot, originUrl, slot: params.slot, env: params.env });
  const now = new Date().toISOString();
  const existing = await readSlotRecord(paths.metadataPath);
  const existingWorkspacePresent = await fs
    .stat(paths.workspaceDir)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (existing && existing.repoRoot === repoRoot && existingWorkspacePresent) {
    const next: RepoSlotRecord = {
      ...existing,
      updatedAt: now,
      originUrl,
      headSha,
      baseRef,
    };
    await writeSlotRecord(next, paths.metadataPath);
    return { created: false, record: next };
  }
  const materialization = await materializeWorktree({
    repoRoot,
    workspaceDir: paths.workspaceDir,
    baseRef,
  });
  const record: RepoSlotRecord = {
    version: 1,
    slot: paths.normalizedSlot,
    repoRoot,
    repoName: paths.repoName,
    repoKey: paths.repoKey,
    originUrl,
    createdAt: now,
    updatedAt: now,
    materialization,
    workspaceDir: paths.workspaceDir,
    headSha,
    baseRef,
  };
  await writeSlotRecord(record, paths.metadataPath);
  return { created: true, record };
}

export async function listRepoSlots(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepoSlotRecord[]> {
  const root = resolveRepoSlotsRoot(env);
  try {
    const repoDirs = await fs.readdir(root, { withFileTypes: true });
    const records: RepoSlotRecord[] = [];
    for (const repoEntry of repoDirs) {
      if (!repoEntry.isDirectory()) {
        continue;
      }
      const repoDir = path.join(root, repoEntry.name);
      const slotDirs = await fs.readdir(repoDir, { withFileTypes: true }).catch(() => []);
      for (const slotEntry of slotDirs) {
        if (!slotEntry.isDirectory()) {
          continue;
        }
        const record = await readSlotRecord(
          path.join(repoDir, slotEntry.name, SLOT_METADATA_FILENAME),
        );
        if (record) {
          records.push(record);
        }
      }
    }
    return records.toSorted(
      (a, b) => a.repoKey.localeCompare(b.repoKey) || a.slot.localeCompare(b.slot),
    );
  } catch {
    return [];
  }
}

export async function resetRepoSlot(params: {
  repoPath: string;
  slot: string;
  ref?: string;
  fetch?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<RepoSlotRecord> {
  const ensured = await ensureRepoSlot({
    repoPath: params.repoPath,
    slot: params.slot,
    baseRef: params.ref,
    env: params.env,
  });
  const record = ensured.record;
  if (params.fetch !== false) {
    await tryRunGit(["-C", record.repoRoot, "fetch", "--all", "--prune", "--tags"]);
  }
  const targetRef = normalizeOptionalString(params.ref) || record.baseRef || "HEAD";
  await runGit(["-C", record.workspaceDir, "checkout", "--detach", targetRef]);
  await runGit(["-C", record.workspaceDir, "reset", "--hard", targetRef]);
  await runGit(["-C", record.workspaceDir, "clean", "-fdx"]);
  const next: RepoSlotRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    baseRef: targetRef,
    headSha: await readHeadSha(record.workspaceDir),
  };
  const paths = resolveRepoSlotPaths({
    repoRoot: record.repoRoot,
    originUrl: record.originUrl,
    slot: record.slot,
    env: params.env,
  });
  await writeSlotRecord(next, paths.metadataPath);
  return next;
}

export async function removeRepoSlot(params: {
  repoPath: string;
  slot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ removed: boolean; workspaceDir: string }> {
  const repoRoot = await resolveGitRepoRoot(params.repoPath);
  const originUrl = await readOriginUrl(repoRoot);
  const paths = resolveRepoSlotPaths({ repoRoot, originUrl, slot: params.slot, env: params.env });
  const existing = await readSlotRecord(paths.metadataPath);
  if (!existing) {
    return { removed: false, workspaceDir: paths.workspaceDir };
  }
  if (existing.materialization === "worktree") {
    await tryRunGit([
      "-C",
      existing.repoRoot,
      "worktree",
      "remove",
      "--force",
      existing.workspaceDir,
    ]);
    await tryRunGit(["-C", existing.repoRoot, "worktree", "prune"]);
  }
  await fs.rm(paths.slotDir, { recursive: true, force: true });
  const remaining = await fs.readdir(paths.repoDir).catch(() => []);
  if (remaining.length === 0) {
    await fs.rm(paths.repoDir, { recursive: true, force: true });
  }
  return { removed: true, workspaceDir: existing.workspaceDir };
}

export function describeRepoSlot(record: RepoSlotRecord): string {
  return [
    `${record.repoName}:${record.slot}`,
    record.materialization,
    shortenHomePath(record.workspaceDir),
    record.headSha ? record.headSha.slice(0, 12) : "unknown",
  ].join("  ");
}

export async function createTempRepoSlotForTest(prefix = "openclaw-slot-test-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
