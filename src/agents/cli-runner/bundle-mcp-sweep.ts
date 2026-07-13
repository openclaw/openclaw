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
 * Persist the owning gateway's identity beside the rendered config. Fail-loud:
 * a caller that cannot record ownership must not queue the run, because an
 * unmarked dir aged past the grace window is reclaimable by a concurrent
 * gateway's sweep — so a silent marker failure would reintroduce the very
 * queued-run deletion this marker prevents. The creator rolls back (removes the
 * temp dir) when this throws.
 */
export async function writeBundleMcpOwnerMarker(dir: string): Promise<void> {
  const owner: BundleMcpOwner = { pid: process.pid, bootId: await readCurrentBootId() };
  await fs.writeFile(path.join(dir, BUNDLE_MCP_OWNER_MARKER), `${JSON.stringify(owner)}\n`, "utf8");
}

/** Cap the marker read/parse so a corrupt local artifact cannot exhaust memory. */
const MAX_OWNER_MARKER_BYTES = 4 * 1024;

/**
 * Resolved owner state for a temp dir. Read/parse ambiguity is preserved rather
 * than collapsed to "no owner": only a definitively absent marker is `legacy`
 * (eligible for the age + argv rule); anything unreadable, oversized, or
 * malformed is `unknown` and kept (fail-closed), because an unreadable marker
 * cannot prove the owner is gone.
 */
type BundleMcpOwnerMarker =
  | { kind: "legacy" }
  | { kind: "owned"; pid: number; bootId?: string }
  | { kind: "unknown" };

async function readBundleMcpOwner(dir: string): Promise<BundleMcpOwnerMarker> {
  const markerPath = path.join(dir, BUNDLE_MCP_OWNER_MARKER);
  let raw: string;
  try {
    const stat = await fs.stat(markerPath);
    if (stat.size > MAX_OWNER_MARKER_BYTES) {
      return { kind: "unknown" }; // Oversized artifact — do not read/parse.
    }
    raw = await fs.readFile(markerPath, "utf8");
  } catch (err) {
    // ENOENT is a true legacy dir; any other error (EACCES, EMFILE, transient
    // I/O) leaves ownership unknown rather than assuming the owner is gone.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "legacy" }
      : { kind: "unknown" };
  }
  let parsed: { pid?: unknown; bootId?: unknown };
  try {
    parsed = JSON.parse(raw) as { pid?: unknown; bootId?: unknown };
  } catch {
    return { kind: "unknown" }; // Corrupt JSON is unknown, not legacy.
  }
  if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    return { kind: "unknown" };
  }
  const bootId =
    typeof parsed.bootId === "string" && parsed.bootId.length > 0 ? parsed.bootId : undefined;
  return { kind: "owned", pid: parsed.pid, bootId };
}

/** Verdict on the gateway that created a dir, driving the sweep's keep/remove. */
type BundleMcpOwnerVerdict = "legacy" | "alive" | "dead" | "unknown";

/**
 * Classify a dir by its owning gateway. An `alive` owner may be a run still
 * waiting in the serialization queue whose CLI child has not spawned yet — no
 * argv references it, but deleting it would make that run spawn with a missing
 * `--mcp-config`. A `dead` owner (pid gone, or boot id changed by a reboot)
 * means the queued run died with its gateway, so the dir is reclaimable
 * regardless of age. `unknown` is kept (fail-closed); `legacy` follows the
 * age + argv rule.
 */
async function resolveBundleMcpOwner(
  dir: string,
  currentBootId: string | undefined,
  isPidAlive: (pid: number) => boolean,
): Promise<BundleMcpOwnerVerdict> {
  const owner = await readBundleMcpOwner(dir);
  if (owner.kind !== "owned") {
    return owner.kind; // "legacy" | "unknown"
  }
  if (owner.bootId !== undefined && currentBootId !== undefined && owner.bootId !== currentBootId) {
    return "dead"; // Host rebooted since creation — the owning gateway is gone.
  }
  return isPidAlive(owner.pid) ? "alive" : "dead";
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
    const owner = await resolveBundleMcpOwner(dir, currentBootId, isPidAlive);
    if (owner === "alive" || owner === "unknown") {
      // "alive": a queued run of a live gateway whose child has not spawned yet
      // (the config is created at prepare time, before `enqueueCliRun`).
      // "unknown": an unreadable marker cannot prove the owner is gone. Keep both.
      kept.push(dir);
      continue;
    }
    if (owner === "legacy" && now - mtimeMs < spawnGraceMs) {
      // A legacy dir prepared moments ago may not have written its marker or
      // spawned its child yet; keep it inside the grace window. Owner-marked
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
