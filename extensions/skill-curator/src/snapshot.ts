import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SnapshotResult {
  archivePath: string;
  timestamp: string;
  sizeBytes: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function backupsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", ".curator_backups");
}

function isoFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runTar(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`tar timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a tar.gz snapshot of <workspaceDir>/skills/ into
 * <workspaceDir>/skills/.curator_backups/<utc-iso>/skills.tar.gz.
 *
 * Excludes .curator_backups and .archive from the tarball to avoid
 * recursive backup bloat. Returns metadata about the created snapshot.
 */
export async function createSnapshot(workspaceDir: string): Promise<SnapshotResult> {
  const timestamp = isoFilename();
  const destDir = path.join(backupsDir(workspaceDir), timestamp);
  const archivePath = path.join(destDir, "skills.tar.gz");
  const manifestPath = path.join(destDir, "manifest.json");

  await fs.mkdir(destDir, { recursive: true });

  const skillsDir = path.join(workspaceDir, "skills");

  // tar -czf <archive> -C <parent> --exclude .curator_backups --exclude .archive skills
  const { code, stderr } = await runTar(path.dirname(skillsDir), [
    "-czf",
    archivePath,
    "--exclude",
    ".curator_backups",
    "--exclude",
    ".archive",
    "skills",
  ]);

  if (code !== 0) {
    throw new Error(`tar exited with code ${code}: ${stderr}`);
  }

  const stat = await fs.stat(archivePath);

  // Write manifest sidecar
  const manifest = {
    created_at: new Date().toISOString(),
    archive_path: archivePath,
    size_bytes: stat.size,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  return {
    archivePath,
    timestamp,
    sizeBytes: stat.size,
  };
}

/**
 * Rotate old snapshots, keeping only the `keep` newest.
 * Snapshots are directories named by UTC ISO timestamp.
 */
export async function rotateSnapshots(workspaceDir: string, keep: number): Promise<string[]> {
  const dir = backupsDir(workspaceDir);
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // No backups dir yet
  }

  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // ISO timestamps sort lexicographically

  if (dirs.length <= keep) {
    return [];
  }

  const toRemove = dirs.slice(0, dirs.length - keep);
  for (const name of toRemove) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }

  return toRemove;
}
