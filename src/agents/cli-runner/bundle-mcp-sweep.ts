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
 * gateway's sweep reclaiming such a dir, the creating gateway's identity (pid +
 * boot-id prefix + process start time) is encoded in the dir NAME; an
 * argv-unreferenced dir is only removed once its owning gateway is gone.
 * Old-format (legacy) dirs without an encoded owner keep the prior age +
 * liveness behaviour.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getWindowsPowerShellExePath } from "../../infra/windows-install-roots.js";

const execFileAsync = promisify(execFile);

const BUNDLE_MCP_TEMP_PREFIX = "openclaw-cli-mcp-";

const DEFAULT_SPAWN_GRACE_MS = 5 * 60 * 1000;
const PROCESS_SCAN_TIMEOUT_MS = 10_000;

/**
 * Owner identity is encoded in the temp dir NAME, not a sibling file:
 * `<prefix><pid>-<boot8>-<startTicks>-<mkdtemp suffix>`. The name is produced
 * atomically by `mkdtemp`, so a prepared run carries durable ownership with no
 * extra write that could fail — the run's success path is unchanged (no
 * availability/compatibility regression), and a concurrent gateway's sweep tells
 * a live-owned queued dir from a true orphan using only the dir name plus the OS
 * process table. `startTicks` (the owner's Linux process start time) guards pid
 * reuse; `boot8` (a Linux boot-id prefix) detects a reboot.
 */
const NO_BOOT_ID = "nobootid";
// Encoded when the creating gateway could not read its own start time. A real
// Linux process start time (ticks since boot) is never 0, so this is an unused
// sentinel meaning "unverifiable" — it must never be compared as a real value
// (that would fail OPEN: a live owner with an unknown creation start could be
// mistaken for a reused pid and deleted).
const UNKNOWN_START = "0";

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process (dead). EPERM: exists but not signalable (alive).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** First 8 hex of the Linux boot id (changes on reboot); NO_BOOT_ID off-Linux. */
async function readBootTag(): Promise<string> {
  if (process.platform !== "linux") {
    return NO_BOOT_ID;
  }
  try {
    const raw = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).replace(
      /[^0-9a-f]/gi,
      "",
    );
    return raw.length >= 8 ? raw.slice(0, 8).toLowerCase() : NO_BOOT_ID;
  } catch {
    return NO_BOOT_ID;
  }
}

/**
 * The owner process's start time in clock ticks since boot, from
 * `/proc/<pid>/stat` field 22. Two processes that reuse a pid within one boot
 * still differ here, so a start-time match proves same-process identity.
 * Returns undefined off-Linux or when the process is gone/unreadable.
 */
async function defaultReadStartTicks(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) is parenthesised and may itself contain spaces or ')'.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const start = afterComm.split(" ")[19]; // field 22 = index 19 counting from field 3
    return start !== undefined && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `mkdtemp` prefix that encodes the creating gateway's identity into the
 * temp dir name. Passed straight to `fs.mkdtemp`, which appends the random
 * suffix atomically — so ownership exists from the instant the dir does.
 */
export async function bundleMcpOwnedMkdtempPrefix(root: string): Promise<string> {
  const boot = await readBootTag();
  const start = (await defaultReadStartTicks(process.pid)) ?? UNKNOWN_START;
  return path.join(root, `${BUNDLE_MCP_TEMP_PREFIX}${process.pid}-${boot}-${start}-`);
}

type BundleMcpOwner = { pid: number; boot: string; start: string };

// <prefix><pid>-<boot8|nobootid>-<startTicks>-<mkdtemp suffix>
const OWNER_NAME_RE = new RegExp(
  `^${BUNDLE_MCP_TEMP_PREFIX}(\\d+)-([0-9a-f]{8}|${NO_BOOT_ID})-(\\d+)-`,
);

function parseBundleMcpOwner(entryName: string): BundleMcpOwner | undefined {
  const match = OWNER_NAME_RE.exec(entryName);
  const [, pidText, boot, start] = match ?? [];
  if (pidText === undefined || boot === undefined || start === undefined) {
    return undefined; // Old-format (pre-ownership) dir — treated as legacy.
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  return { pid, boot, start };
}

/** Verdict on the gateway that created a dir, driving the sweep's keep/remove. */
type BundleMcpOwnerVerdict = "legacy" | "alive" | "dead";

/**
 * Classify a dir by the owner encoded in its name. `alive` may be a run still
 * waiting in the serialization queue whose CLI child has not spawned yet — no
 * argv references it, but deleting it would make that run spawn with a missing
 * `--mcp-config`. `dead` (pid gone, boot id changed by a reboot, or the pid
 * reused by a different process) means the queued run died with its gateway, so
 * the dir is reclaimable regardless of age. `legacy` (unparseable old-format
 * name) follows the age + argv rule.
 */
async function resolveBundleMcpOwner(
  entryName: string,
  currentBoot: string,
  isPidAlive: (pid: number) => boolean,
  readStartTicks: (pid: number) => Promise<string | undefined>,
): Promise<BundleMcpOwnerVerdict> {
  const owner = parseBundleMcpOwner(entryName);
  if (!owner) {
    return "legacy";
  }
  if (owner.boot !== NO_BOOT_ID && currentBoot !== NO_BOOT_ID && owner.boot !== currentBoot) {
    return "dead"; // Host rebooted since creation — the owning gateway is gone.
  }
  if (!isPidAlive(owner.pid)) {
    return "dead";
  }
  if (owner.start === UNKNOWN_START) {
    // Creation could not record a start time, so pid reuse cannot be proven —
    // trust the live pid (fail closed) rather than risk deleting a live config.
    return "alive";
  }
  const actualStart = await readStartTicks(owner.pid);
  if (actualStart === undefined) {
    return "alive"; // Cannot verify start (off-Linux/hidden) — trust the pid (over-protect).
  }
  return actualStart === owner.start ? "alive" : "dead"; // start mismatch → pid reused → gone.
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
  /** Override the process start-time probe (tests). Defaults to `/proc/<pid>/stat`. */
  readStartTicks?: (pid: number) => Promise<string | undefined>;
  /** Override the current boot tag (tests). Defaults to the host boot-id prefix on Linux. */
  currentBoot?: string;
  log?: { warn: (msg: string) => void };
}): Promise<{ removed: string[]; kept: string[] }> {
  const tmpRoot = params?.tmpRoot ?? os.tmpdir();
  const spawnGraceMs = params?.spawnGraceMs ?? DEFAULT_SPAWN_GRACE_MS;
  const isPidAlive = params?.isPidAlive ?? defaultIsPidAlive;
  const readStartTicks = params?.readStartTicks ?? defaultReadStartTicks;
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

  const currentBoot = params?.currentBoot ?? (await readBootTag());
  const now = Date.now();

  // Phase 1 — classify. A dir becomes a removal candidate only when nothing live
  // references it AND its owning gateway is gone (or it is an aged legacy dir).
  const candidates: string[] = [];
  for (const entry of entries) {
    const dir = path.join(tmpRoot, entry);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      continue; // Raced away since readdir.
    }
    if (commandLines.some((line) => lineReferencesDir(line, dir))) {
      // A live CLI child (of this gateway, a concurrent gateway, or a
      // persistent live session) still references the config — keep (#73244).
      kept.push(dir);
      continue;
    }
    const owner = await resolveBundleMcpOwner(entry, currentBoot, isPidAlive, readStartTicks);
    if (owner === "alive") {
      // A queued run of a live gateway whose child has not spawned yet (the
      // config is created at prepare time, before `enqueueCliRun`).
      kept.push(dir);
      continue;
    }
    if (owner === "legacy" && now - mtimeMs < spawnGraceMs) {
      // An old-format dir with no encoded owner, created moments ago, may not
      // have spawned its child yet; keep it inside the grace window. Owner-named
      // dirs skip the grace check on purpose: a dead owner's config is
      // reclaimable at any age, which is what lets a prompt gateway restart
      // reclaim its own fresh crash debris instead of leaking it until the next
      // restart.
      kept.push(dir);
      continue;
    }
    candidates.push(dir); // "dead" (any age) or aged "legacy".
  }

  if (candidates.length === 0) {
    return { removed, kept };
  }

  // Phase 2 — re-scan argv immediately before removing. A CLI child can spawn
  // between the first snapshot and now (a queued run whose owner died just as
  // its child started), so a fresh reference means keep. An unusable (empty)
  // re-scan is treated as unknown and keeps every candidate (fail-closed).
  const recheck = await (params?.listCommandLines ?? listProcessCommandLines)();
  const recheckUsable = recheck.length > 0;
  for (const dir of candidates) {
    if (!recheckUsable || recheck.some((line) => lineReferencesDir(line, dir))) {
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
