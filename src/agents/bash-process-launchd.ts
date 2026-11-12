import { createHash } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveStateDir } from "../config/paths.js";
import { DURABLE_PROCESS_LAUNCHD_LABEL_PREFIX } from "../daemon/constants.js";
import { hasErrnoCode } from "../infra/errors.js";
import type { RunExit } from "../process/supervisor/types.js";
import { escapeXml } from "../shared/xml.js";
import {
  runDurableControlCommand,
  type DurableControlOptions,
} from "./bash-process-durable-command.js";
import { DURABLE_LAUNCHD_WRAPPER_SOURCE } from "./bash-process-launchd-wrapper.js";
import type { DurableLaunchOptions, DurableProcessObservation } from "./bash-process-systemd.js";

type StopOptions = Pick<DurableControlOptions, "assertCurrent">;
type WrapperStatus =
  | { phase: "running"; pgid: number }
  | {
      phase: "exited";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      reason: "exit" | "signal" | "overall-timeout" | "spawn-error";
      durationMs: number;
    };

const REQUIREMENT =
  "Durable exec requires Gateway-host execution on Linux with systemd 250 or newer, or on macOS from a logged-in user's GUI (Aqua) session. Use ordinary background exec on unsupported hosts.";
const KILL_GRACE_MS = 10_000;
const failure = () =>
  new Error(
    "Durable process control was not confirmed; inspect process status and `launchctl list` before retrying.",
  );
const LOST_NOTE =
  "\nDurable process supervisor ended before recording the outcome; outcome unknown. Check saved output and side effects before repeating work.\n";
const command = (argv: string[], options: DurableControlOptions = {}): Promise<RunExit> =>
  runDurableControlCommand(argv, options, failure);
const domain = () => `gui/${process.getuid!()}`;
const directory = () => path.join(resolveStateDir(), "processes");
const file = (label: string, suffix: string) => path.join(directory(), `${label}${suffix}`);

export function durableProcessUnitName(id: string): string {
  return `${DURABLE_PROCESS_LAUNCHD_LABEL_PREFIX}${createHash("sha256").update(id).digest("hex")}`;
}

function assertLabel(label: string) {
  if (
    !new RegExp(
      `^${DURABLE_PROCESS_LAUNCHD_LABEL_PREFIX.replaceAll(".", "\\.")}[a-f0-9]{64}$`,
    ).test(label)
  ) {
    throw new Error("Invalid durable process job identity.");
  }
}

export async function requireDurableProcessHost(): Promise<void> {
  try {
    if (process.platform !== "darwin" || typeof process.getuid !== "function") {
      throw failure();
    }
    // Only the Aqua session's gui domain runs jobs for a logged-in user; SSH and
    // background sessions report another manager and cannot host durable work.
    const manager = await command(["launchctl", "managername"]);
    if (manager.exitCode !== 0 || manager.stdout.trim() !== "Aqua") {
      throw failure();
    }
  } catch {
    throw new Error(REQUIREMENT);
  }
}

async function readStatus(label: string): Promise<WrapperStatus | undefined> {
  let text: string;
  try {
    text = await readFile(file(label, ".status.json"), "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  // SAFETY: Only the wrapper writes this file, by atomic rename.
  return JSON.parse(text) as WrapperStatus;
}

/** Bare `launchctl list` prints documented PID, last exit status and label columns. */
async function listJob(label: string): Promise<{ pid?: number; status: number } | undefined> {
  const reply = await command(["launchctl", "list"]);
  const [header, ...rows] = reply.stdout.split("\n");
  if (reply.exitCode !== 0 || header?.trim().split(/\s+/).join(" ") !== "PID Status Label") {
    throw failure();
  }
  for (const row of rows) {
    const fields = row.split("\t");
    if (fields[2] !== label) {
      continue;
    }
    const pid = fields[0] === "-" ? undefined : Number(fields[0]);
    const status = Number(fields[1]);
    if ((pid !== undefined && !(Number.isInteger(pid) && pid > 0)) || !Number.isInteger(status)) {
      throw failure();
    }
    return { pid, status };
  }
  return undefined;
}

// EPERM means some process still holds the group; only ESRCH proves it empty.
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return !hasErrnoCode(error, "ESRCH");
  }
}

function exited(status: Extract<WrapperStatus, { phase: "exited" }>): DurableProcessObservation {
  return {
    state: "exited",
    exitCode: status.exitCode,
    exitSignal: status.exitSignal,
    reason: status.reason,
    result: status.reason,
    durationMs: status.durationMs,
  };
}

export async function readDurableProcess(label: string): Promise<DurableProcessObservation> {
  assertLabel(label);
  const before = await readStatus(label);
  if (before?.phase === "exited") {
    return exited(before);
  }
  const job = await listJob(label);
  // The wrapper can record its exit between the two reads.
  const status = await readStatus(label);
  if (status?.phase === "exited") {
    return exited(status);
  }
  if (job?.pid) {
    return { state: "running", pid: job.pid };
  }
  if (status?.phase === "running") {
    // The wrapper is gone (for example SIGKILL), so check the group it recorded at start.
    // Accepted edge case: a reused process-group id would read as still running.
    return groupAlive(status.pgid)
      ? { state: "running" }
      : {
          state: "exited",
          exitCode: null,
          exitSignal: null,
          reason: "spawn-error",
          result: "supervisor-lost",
          note: LOST_NOTE,
        };
  }
  if (!job) {
    return { state: "missing" };
  }
  // Loaded without a PID or status file: launchd has not started the wrapper yet. A
  // nonzero last exit status proves it ran and failed before reading its spec.
  return job.status === 0
    ? { state: "running" }
    : {
        state: "exited",
        exitCode: null,
        exitSignal: null,
        reason: "spawn-error",
        result: `launchd-status-${job.status}`,
        note: `\nDurable process supervisor failed to start (launchd status ${job.status}).\n`,
      };
}

export async function launchDurableProcess(
  params: DurableLaunchOptions,
): Promise<{ unitName: string }> {
  const label = durableProcessUnitName(params.id);
  const digest = createHash("sha256").update(DURABLE_LAUNCHD_WRAPPER_SOURCE).digest("hex");
  // Content-addressed: an update never rewrites the copy a running job executes.
  const wrapperPath = path.join(directory(), `durable-wrapper-${digest.slice(0, 16)}.cjs`);
  await writeFile(wrapperPath, DURABLE_LAUNCHD_WRAPPER_SOURCE, { flag: "wx", mode: 0o600 }).catch(
    (error: unknown) => {
      if (!hasErrnoCode(error, "EEXIST")) {
        throw error;
      }
    },
  );
  const specPath = file(label, ".spec.json");
  const spec = {
    argv: params.argv,
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    statusPath: file(label, ".status.json"),
    timeoutMs: params.timeoutMs ?? 0,
    killGraceMs: KILL_GRACE_MS,
  };
  await writeFile(specPath, JSON.stringify(spec), { flag: "wx", mode: 0o600 });
  const strings = (values: string[]) =>
    values.map((value) => `<string>${escapeXml(value)}</string>`).join("");
  const plistPath = file(label, ".plist");
  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings([process.execPath, wrapperPath, specPath])}</array>
<key>WorkingDirectory</key>${strings([directory()])}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Interactive</string>
<key>ExitTimeOut</key><integer>${KILL_GRACE_MS / 1000 + 5}</integer>
<key>SoftResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
<key>HardResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
<key>StandardOutPath</key>${strings([params.logPath])}
<key>StandardErrorPath</key>${strings([params.logPath])}
</dict></plist>
`,
    { flag: "wx" },
  );
  // launchd refuses group- or other-writable plists; umask must not decide this.
  await chmod(plistPath, 0o644);
  const result = await command(["launchctl", "bootstrap", domain(), plistPath], {
    assertCurrent: params.assertCurrent,
    initiateSpawn: params.initiateSpawn,
  });
  if (result.exitCode !== 0) {
    throw failure();
  }
  return { unitName: label };
}

/** Ask the wrapper to stop its group, then wait for its recorded outcome. */
export async function stopDurableProcess(label: string, options: StopOptions = {}): Promise<void> {
  assertLabel(label);
  const job = await listJob(label);
  const status = await readStatus(label);
  if (status?.phase === "exited") {
    return;
  }
  let orphan: number | undefined;
  const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(-pgid, signal);
    } catch {}
  };
  if (job?.pid) {
    const reply = await command(["launchctl", "kill", "SIGTERM", `${domain()}/${label}`], options);
    if (reply.exitCode !== 0 && (await readDurableProcess(label)).state === "running") {
      throw failure();
    }
  } else if (status?.phase === "running" && groupAlive(status.pgid)) {
    // No wrapper is left to escalate; signal the recorded group directly.
    options.assertCurrent?.();
    orphan = status.pgid;
    signalGroup(orphan, "SIGTERM");
  }
  const deadline = Date.now() + KILL_GRACE_MS + 5_000;
  let killed = false;
  while ((await readDurableProcess(label)).state === "running") {
    if (orphan !== undefined && !killed && Date.now() > deadline - 5_000) {
      killed = true;
      signalGroup(orphan, "SIGKILL");
    }
    if (Date.now() > deadline) {
      throw failure();
    }
    await sleep(250);
  }
}

/** The registry records the real result before the job and its files are released. */
export async function cleanupDurableProcess(label: string, options?: StopOptions): Promise<void> {
  assertLabel(label);
  const reply = await command(["launchctl", "bootout", `${domain()}/${label}`], options);
  if (reply.exitCode !== 0 && (await listJob(label))) {
    throw failure();
  }
  for (const suffix of [".plist", ".spec.json", ".status.json", ".status.json.tmp"]) {
    await rm(file(label, suffix), { force: true });
  }
}
