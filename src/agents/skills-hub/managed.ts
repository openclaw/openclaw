import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { OpenClawConfig } from "../../config/config.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { installPackageDir } from "../../infra/install-package-dir.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { scanDirectoryWithSummary, type SkillScanSummary } from "../../security/skill-scanner.js";
import { CONFIG_DIR } from "../../utils.js";
import { installSkillFromClawHub } from "../skills-clawhub.js";
import {
  computeDirectoryContentHash,
  computeSkillMarkdownHash,
  readHubLockfile,
  upsertLockSkill,
  writeHubLockfile,
  type HubLockSkillEntry,
} from "./lockfile.js";

type ManagedParams = {
  config?: OpenClawConfig;
};

export type ManagedSkillRow = {
  name: string;
  dirPath: string;
  exists: boolean;
  lock?: HubLockSkillEntry;
};

function resolveManagedSkillsRoot(): string {
  return path.join(CONFIG_DIR, "skills");
}

function resolveHubLockfilePath(rootDir: string): string {
  return path.join(rootDir, "hub.lock.json");
}

function summarizeVerdict(summary: SkillScanSummary): "safe" | "warn" | "critical" {
  if (summary.critical > 0) {
    return "critical";
  }
  if (summary.warn > 0) {
    return "warn";
  }
  return "safe";
}

export function enforceManagedScanPolicy(params: {
  summary: SkillScanSummary;
  skillName: string;
  force?: boolean;
}): { ok: true } | { ok: false; message: string } {
  if (params.force || params.summary.critical === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `Managed install/update blocked for "${params.skillName}": ` +
      `${params.summary.critical} critical finding(s). Re-run with --force to override.`,
  };
}

export async function listManagedSkills(_params: ManagedParams = {}): Promise<ManagedSkillRow[]> {
  const rootDir = resolveManagedSkillsRoot();
  const lockfilePath = resolveHubLockfilePath(rootDir);
  const lock = await readHubLockfile(lockfilePath);
  const rows: ManagedSkillRow[] = [];
  for (const entry of lock.skills) {
    const dirPath = path.join(rootDir, entry.name);
    const exists = await fs
      .stat(dirPath)
      .then((st) => st.isDirectory())
      .catch(() => false);
    rows.push({ name: entry.name, dirPath, exists, lock: entry });
  }
  return rows;
}

async function downloadGithubArchive(params: {
  repoUrl: string;
  ref: string;
  archivePath: string;
}): Promise<void> {
  const url = new URL(params.repoUrl);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new Error(`Invalid GitHub repository URL: ${params.repoUrl}`);
  }
  const owner = match[1];
  const repo = match[2];
  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(params.ref)}`;
  const { response, release } = await fetchWithSsrFGuard({ url: archiveUrl, timeoutMs: 60_000 });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`GitHub archive download failed (${response.status} ${response.statusText})`);
    }
    const out = await fs.open(params.archivePath, "w");
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream),
        out.createWriteStream(),
      );
    } finally {
      await out.close();
    }
  } finally {
    await release();
  }
}

async function updateFromGithub(params: {
  rootDir: string;
  lock: HubLockSkillEntry;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tempRoot = await fs.mkdtemp(path.join(params.rootDir, ".hub-update-"));
  const archivePath = path.join(tempRoot, "github-skill.tar.gz");
  try {
    await downloadGithubArchive({
      repoUrl: params.lock.url,
      ref: params.lock.ref,
      archivePath,
    });
    const extracted = await withExtractedArchiveRoot({
      archivePath,
      tempDirPrefix: "openclaw-managed-github-",
      timeoutMs: 120_000,
      rootMarkers: ["SKILL.md"],
      onExtracted: async (sourceDir) => {
        const targetDir = path.join(params.rootDir, params.lock.name);
        const install = await installPackageDir({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 120_000,
          copyErrorPrefix: "failed to install managed skill",
          hasDeps: false,
          depsLogMessage: "",
        });
        return install.ok ? { ok: true as const } : { ok: false as const, error: install.error };
      },
    });
    if (!extracted.ok) {
      return { ok: false, error: extracted.error };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function auditManagedSkills(
  _params: ManagedParams = {},
): Promise<{ rows: ManagedSkillRow[]; summaries: Record<string, SkillScanSummary> }> {
  const rootDir = resolveManagedSkillsRoot();
  const lockfilePath = resolveHubLockfilePath(rootDir);
  const lock = await readHubLockfile(lockfilePath);
  const rows = await listManagedSkills();
  const summaries: Record<string, SkillScanSummary> = {};
  let nextLock = lock;

  for (const row of rows) {
    if (!row.exists) {
      continue;
    }
    let summary: SkillScanSummary;
    try {
      summary = await scanDirectoryWithSummary(row.dirPath);
    } catch {
      summary = { scannedFiles: 0, critical: 0, warn: 1, info: 0, findings: [] };
    }
    summaries[row.name] = summary;
    const contentHash = await computeDirectoryContentHash(row.dirPath);
    const skillMdHash = await computeSkillMarkdownHash(row.dirPath);
    const base = row.lock;
    if (!base) {
      continue;
    }
    nextLock = upsertLockSkill(nextLock, {
      ...base,
      contentHash,
      ...(skillMdHash ? { skillMdHash } : {}),
      scan: {
        critical: summary.critical,
        warn: summary.warn,
        info: summary.info,
        verdict: summarizeVerdict(summary),
      },
    });
  }

  await writeHubLockfile(lockfilePath, nextLock);
  return { rows, summaries };
}

export async function updateManagedSkills(params: {
  config?: OpenClawConfig;
  force?: boolean;
}): Promise<Array<{ name: string; ok: boolean; message: string }>> {
  const rootDir = resolveManagedSkillsRoot();
  const lockfilePath = resolveHubLockfilePath(rootDir);
  const lock = await readHubLockfile(lockfilePath);
  const results: Array<{ name: string; ok: boolean; message: string }> = [];
  let nextLock = lock;

  for (const entry of lock.skills) {
    const skillDir = path.join(rootDir, entry.name);
    const backupRoot = await fs.mkdtemp(path.join(rootDir, ".hub-update-backup-"));
    const backupDir = path.join(backupRoot, entry.name);
    const hadExistingSkill = await fs
      .stat(skillDir)
      .then((st) => st.isDirectory())
      .catch(() => false);
    if (hadExistingSkill) {
      await fs.cp(skillDir, backupDir, { recursive: true });
    }
    try {
      const updateResult =
        entry.source === "clawhub"
          ? await installSkillFromClawHub({
              workspaceDir: CONFIG_DIR,
              slug: entry.name,
              version: entry.ref,
              force: true,
            })
          : await updateFromGithub({ rootDir, lock: entry });
      if (!updateResult.ok) {
        results.push({
          name: entry.name,
          ok: false,
          message: "error" in updateResult ? updateResult.error : "update failed",
        });
        if (hadExistingSkill) {
          await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
          await fs.cp(backupDir, skillDir, { recursive: true });
        }
        continue;
      }
      const summary = await scanDirectoryWithSummary(skillDir);
      const policy = enforceManagedScanPolicy({
        summary,
        skillName: entry.name,
        force: Boolean(params.force),
      });
      if (!policy.ok) {
        if (hadExistingSkill) {
          await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
          await fs.cp(backupDir, skillDir, { recursive: true });
        } else {
          await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
        }
        results.push({ name: entry.name, ok: false, message: policy.message });
        continue;
      }
      const contentHash = await computeDirectoryContentHash(skillDir);
      const skillMdHash = await computeSkillMarkdownHash(skillDir);
      nextLock = upsertLockSkill(nextLock, {
        ...entry,
        contentHash,
        ...(skillMdHash ? { skillMdHash } : {}),
        scan: {
          critical: summary.critical,
          warn: summary.warn,
          info: summary.info,
          verdict: summarizeVerdict(summary),
        },
        installedAt: Date.now(),
      });
      results.push({ name: entry.name, ok: true, message: "updated" });
    } finally {
      await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  await writeHubLockfile(lockfilePath, nextLock);
  return results;
}
