/**
 * Reclaims bundled MCP temp config dirs (`openclaw-cli-mcp-*`) orphaned by
 * gateway death. The per-run cleanup callback (bundle-mcp.ts) lives in gateway
 * memory: when the gateway process exits with runs in flight (restart, crash,
 * SIGKILL), the callback dies with it and the temp dir — including the rendered
 * `mcp.json` with the loopback URL and resolved tokens — leaks.
 *
 * Orphan detection is liveness-based, not age-based: live CLI subprocesses
 * carry the config path in their argv (`--mcp-config <dir>/mcp.json`, see
 * `injectClaudeMcpConfigArgs`), and live-session dirs can legitimately persist
 * across turns for days — removing a dir still referenced by a persistent CLI
 * child would regress the failure fixed in #73244. A dir is only removed when
 * no running process references it AND it is older than a short grace window,
 * which protects the mkdtemp→spawn race of a run being prepared right now
 * whose child has not spawned yet.
 *
 * False positives in the liveness check (an unrelated process merely mentioning
 * the path in its argv) only KEEP a dir for another boot — the safe direction.
 * Under Linux `hidepid`, processes of the same uid as the gateway (which is
 * what spawns the CLI children) remain visible, so their configs stay
 * protected; a scan that yields nothing at all is treated as unknown and the
 * sweep fails closed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getWindowsPowerShellExePath } from "../../infra/windows-install-roots.js";

const execFileAsync = promisify(execFile);

export const BUNDLE_MCP_TEMP_PREFIX = "openclaw-cli-mcp-";

const DEFAULT_SPAWN_GRACE_MS = 5 * 60 * 1000;
const PROCESS_SCAN_TIMEOUT_MS = 10_000;

async function listPosixCommandLinesViaPs(): Promise<string[]> {
  try {
    const res = await execFileAsync("ps", ["-axww", "-o", "command="], {
      encoding: "utf8",
      timeout: PROCESS_SCAN_TIMEOUT_MS,
    });
    return res.stdout.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function listLinuxCommandLinesViaProc(): Promise<string[]> {
  let pids: string[];
  try {
    pids = (await fs.readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const pid of pids) {
    try {
      lines.push((await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " "));
    } catch {
      // Process exited mid-scan or entry is unreadable — skip.
    }
  }
  return lines;
}

async function listWindowsCommandLines(): Promise<string[]> {
  try {
    const res = await execFileAsync(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: "utf8", timeout: PROCESS_SCAN_TIMEOUT_MS, windowsHide: true },
    );
    return res.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * List the command lines of all visible processes. Returns an empty array when
 * nothing could be listed, which callers must treat as "unknown" rather than
 * "no processes" (see fail-closed handling in the sweep).
 */
async function listProcessCommandLines(): Promise<string[]> {
  if (process.platform === "win32") {
    return await listWindowsCommandLines();
  }
  // `ps` is a single call and covers all POSIX platforms; minimal container
  // images without procps fall back to a direct /proc walk on Linux.
  const viaPs = await listPosixCommandLinesViaPs();
  if (viaPs.length > 0) {
    return viaPs;
  }
  if (process.platform === "linux") {
    return await listLinuxCommandLinesViaProc();
  }
  return [];
}

function lineReferencesDir(line: string, dir: string): boolean {
  // Live CLI children carry `--mcp-config <dir>/mcp.json` in their argv; the
  // bare-dir check keeps anything else that mentions the dir (safe direction).
  const configPath = path.join(dir, "mcp.json");
  if (process.platform === "win32") {
    const lowered = line.toLowerCase();
    return lowered.includes(configPath.toLowerCase()) || lowered.includes(dir.toLowerCase());
  }
  return line.includes(configPath) || line.includes(dir);
}

/**
 * Remove `openclaw-cli-mcp-*` temp dirs that no live process references.
 * Intended to run once at gateway startup (post-ready sidecar), mirroring
 * `cleanupStaleSessionLocks`.
 */
export async function sweepOrphanedBundleMcpTempDirs(params?: {
  /** Override the scanned root (tests). Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Dirs younger than this are always kept. Defaults to 5 minutes. */
  spawnGraceMs?: number;
  /** Override the process scan (tests). */
  listCommandLines?: () => string[] | Promise<string[]>;
  log?: { warn: (msg: string) => void };
}): Promise<{ removed: string[]; kept: string[] }> {
  const tmpRoot = params?.tmpRoot ?? os.tmpdir();
  const spawnGraceMs = params?.spawnGraceMs ?? DEFAULT_SPAWN_GRACE_MS;
  const removed: string[] = [];
  const kept: string[] = [];

  let entries: string[];
  try {
    entries = (await fs.readdir(tmpRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(BUNDLE_MCP_TEMP_PREFIX))
      .map((entry) => entry.name);
  } catch {
    return { removed, kept };
  }
  if (entries.length === 0) {
    return { removed, kept };
  }

  // One process scan covers the whole sweep. Fail closed when it yields
  // nothing: an empty result is indistinguishable from a restricted
  // environment, and keeping a leaked dir beats breaking a live run.
  const commandLines = await (params?.listCommandLines ?? listProcessCommandLines)();
  if (commandLines.length === 0) {
    return { removed, kept: entries.map((entry) => path.join(tmpRoot, entry)) };
  }

  const now = Date.now();
  for (const entry of entries) {
    const dir = path.join(tmpRoot, entry);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      continue; // Raced away since readdir.
    }
    if (now - mtimeMs < spawnGraceMs) {
      // A run prepared moments ago may not have spawned its child yet, so the
      // argv scan cannot see it. Leave recent dirs for the next sweep.
      kept.push(dir);
      continue;
    }
    if (commandLines.some((line) => lineReferencesDir(line, dir))) {
      // A live CLI child (of this gateway, a concurrent gateway, or a
      // persistent live session) still references the config — keep (#73244).
      kept.push(dir);
      continue;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      params?.log?.warn(`bundle MCP temp sweep: failed to remove ${dir}: ${String(err)}`);
      kept.push(dir);
    }
  }
  return { removed, kept };
}
