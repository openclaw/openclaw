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
 *
 * Argv liveness alone is not enough: the config is rendered at prepare time,
 * before the run enters the serialization queue, so a run waiting in the queue
 * owns a config that no process argv references yet. To avoid a concurrent
 * gateway's sweep reclaiming such a dir, each dir carries an owner marker (the
 * creating gateway's pid + boot id); an aged, argv-unreferenced dir is only
 * removed once its owning gateway is gone. Unmarked (legacy) dirs keep the
 * prior age + liveness behaviour.
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

/**
 * Marker written beside the rendered `mcp.json` recording the gateway that owns
 * the dir. It lets a concurrent gateway's startup sweep distinguish a dir owned
 * by a still-live gateway (e.g. a run waiting in the serialization queue whose
 * CLI child has not spawned yet, so no argv references it) from a true orphan.
 */
const BUNDLE_MCP_OWNER_MARKER = ".owner.json";

type BundleMcpOwner = { pid: number; bootId?: string };

/** Linux boot id (changes on reboot); undefined off-Linux — best-effort only. */
async function readCurrentBootId(): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process (dead). EPERM: exists but not signalable (alive).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Persist the owning gateway's identity beside the rendered config. Best-effort:
 * a failed write leaves the dir unmarked, which the sweep treats as legacy
 * (age + liveness only), so a marker failure can never over-protect a leak.
 */
export async function writeBundleMcpOwnerMarker(dir: string): Promise<void> {
  const owner: BundleMcpOwner = { pid: process.pid, bootId: await readCurrentBootId() };
  try {
    await fs.writeFile(
      path.join(dir, BUNDLE_MCP_OWNER_MARKER),
      `${JSON.stringify(owner)}\n`,
      "utf8",
    );
  } catch {
    // Non-fatal: unmarked dirs fall back to the legacy age + liveness rule.
  }
}

async function readBundleMcpOwner(dir: string): Promise<BundleMcpOwner | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, BUNDLE_MCP_OWNER_MARKER), "utf8");
  } catch {
    return undefined; // No marker: legacy dir (pre-ownership or a foreign leak).
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; bootId?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        bootId: typeof parsed.bootId === "string" ? parsed.bootId : undefined,
      };
    }
  } catch {
    // Corrupt marker — treat as unmarked (legacy handling).
  }
  return undefined;
}

/**
 * Whether the gateway that created `dir` is still alive. An owned dir may be a
 * run still waiting in the serialization queue whose CLI child has not spawned
 * yet — no argv references it, but deleting it would make that run spawn with a
 * missing `--mcp-config`. Unmarked (legacy) dirs return false so their handling
 * is unchanged. A changed boot id means the host rebooted and the owner is gone.
 */
async function isBundleMcpOwnerAlive(
  dir: string,
  currentBootId: string | undefined,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  const owner = await readBundleMcpOwner(dir);
  if (!owner) {
    return false;
  }
  if (owner.bootId !== undefined && currentBootId !== undefined && owner.bootId !== currentBootId) {
    return false;
  }
  return isPidAlive(owner.pid);
}

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
  /** Override the owner liveness probe (tests). Defaults to `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
  /** Override the current boot id (tests). Defaults to the host boot id on Linux. */
  currentBootId?: string;
  log?: { warn: (msg: string) => void };
}): Promise<{ removed: string[]; kept: string[] }> {
  const tmpRoot = params?.tmpRoot ?? os.tmpdir();
  const spawnGraceMs = params?.spawnGraceMs ?? DEFAULT_SPAWN_GRACE_MS;
  const isPidAlive = params?.isPidAlive ?? defaultIsPidAlive;
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

  const currentBootId = params?.currentBootId ?? (await readCurrentBootId());
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
    if (await isBundleMcpOwnerAlive(dir, currentBootId, isPidAlive)) {
      // The owning gateway is still alive, so this may be a run waiting in the
      // serialization queue whose CLI child has not spawned yet — no argv
      // references it, but deleting it would make that run spawn with a missing
      // `--mcp-config`. The config is created at prepare time, before the run
      // enters `enqueueCliRun`, so a serialized run can outlive the grace window
      // without a child. Only reclaim once the owning gateway is gone.
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
