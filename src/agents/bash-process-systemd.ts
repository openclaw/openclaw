import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseKeyValueOutput } from "../daemon/runtime-parse.js";
import { hasErrnoCode } from "../infra/errors.js";
import { getHostExecMemoryBudget } from "../process/child-memory.js";
import { describeLiveProcesses } from "../process/supervisor/service-child-group-ownership.js";
import type { RunExit, TerminationReason } from "../process/supervisor/types.js";
import {
  runDurableControlCommand,
  type DurableControlOptions as ControlOptions,
  type DurableLaunchOptions,
  type DurableProcessObservation,
  type DurableProcessSupervisor,
  type DurableStopOptions as StopOptions,
} from "./bash-process-durable-supervisor.js";

const REQUIREMENT =
  "Durable exec requires Gateway-host execution on Linux, systemd 250 or newer, and a reachable Gateway user's systemd manager (XDG_RUNTIME_DIR or DBUS_SESSION_BUS_ADDRESS). Use ordinary background exec on unsupported hosts.";
const MANAGER_KEYS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
const EXIT_REASONS: Record<string, TerminationReason> = {
  timeout: "overall-timeout",
  "oom-kill": "memory-limit",
};
let version: Promise<number> | undefined;
// systemd stops (and so kills) a unit whose main process fails. Every exit counts as
// success so what the command left running survives; ExecMainCode/Status keep the real result.
// Accepted edge case: a root killed by a real-time signal still fails the unit.
const SUCCESS_EXIT_STATUS = [
  ...Array.from({ length: 255 }, (_, index) => index + 1),
  ...[
    "HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT",
    "CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO PWR SYS",
  ]
    .join(" ")
    .split(" ")
    .map((name) => `SIG${name}`),
].join(" ");
const failure = () =>
  new Error(
    "Durable process control was not confirmed; inspect process status and the systemd user manager before retrying.",
  );

const command = (argv: string[], options: ControlOptions = {}): Promise<RunExit> =>
  runDurableControlCommand(argv, options, failure);

function durableProcessUnitName(id: string): string {
  return `openclaw-proc-${createHash("sha256").update(id).digest("hex")}.service`;
}

function control(args: string[], unit: string, options?: StopOptions) {
  if (!/^openclaw-proc-[a-f0-9]{64}\.service$/.test(unit)) {
    throw new Error("Invalid durable process unit identity.");
  }
  return command(["systemctl", "--user", "--no-ask-password", ...args, "--", unit], options);
}

async function requireDurableProcessHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform !== "linux" || !MANAGER_KEYS.some((key) => process.env[key])) {
    throw new Error(REQUIREMENT);
  }
  if (MANAGER_KEYS.some((key) => env[key] !== undefined && env[key] !== process.env[key])) {
    throw new Error(`${REQUIREMENT} Remove user-manager environment overrides.`);
  }
  try {
    const cliVersion = await (version ??= command(["systemctl", "--user", "--version"]).then(
      (reply) => Number(/^systemd (\d+)/m.exec(reply.stdout)?.[1]),
    ));
    const manager = await command(["systemctl", "--user", "show", "--property=Version"]);
    if (
      !(cliVersion >= 250) ||
      manager.exitCode !== 0 ||
      !(Number(/^Version=(\d+)/m.exec(manager.stdout)?.[1]) >= 250)
    ) {
      throw failure();
    }
  } catch {
    throw new Error(REQUIREMENT);
  }
}

async function launchDurableProcess(params: DurableLaunchOptions): Promise<{ unitName: string }> {
  const unitName = durableProcessUnitName(params.id);
  // The manager can retain credentials ordinary exec omitted; discard names absent from the launch env.
  const manager = await command(["systemctl", "--user", "show-environment"]);
  if (manager.exitCode !== 0) {
    throw failure();
  }
  const unset = manager.stdout
    .split("\n")
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter((key) => key && !(key in params.env));
  const budget = getHostExecMemoryBudget();
  const properties = {
    Type: "exec",
    // The unit ends with the command's own exit; RemainAfterExit retains the result and
    // whatever the command left running until cleanup finds it gone.
    RemainAfterExit: "yes",
    SuccessExitStatus: SUCCESS_EXIT_STATUS,
    KillMode: "control-group",
    TimeoutStopSec: "10s",
    LimitCORE: 0,
    StandardInput: "null",
    StandardOutput: `append:${params.logPath}`,
    StandardError: "inherit",
    RuntimeMaxSec: params.timeoutMs ? `${params.timeoutMs / 1000}s` : "infinity",
    // Bound one unit at the full allowance; the sampler accounts concurrent work.
    MemoryMax: budget?.memoryBytes ?? "infinity",
    ...(budget ? { MemorySwapMax: budget.swapBytes, OOMPolicy: "kill" } : {}),
    UnsetEnvironment: unset.join(" "),
  };
  const helperEnv: NodeJS.ProcessEnv = { ...params.env };
  for (const key of MANAGER_KEYS) {
    helperEnv[key] = process.env[key];
  }
  const result = await command(
    [
      "systemd-run",
      "--user",
      "--quiet",
      "--no-ask-password",
      `--unit=${unitName}`,
      "--description=OpenClaw durable process",
      `--working-directory=${params.cwd}`,
      ...Object.entries(properties).map(([key, value]) => `--property=${key}=${value}`),
      // Values stay in the helper's environment; systemd-run copies each named value privately.
      ...Object.keys(params.env).map((key) => `--setenv=${key}`),
      "--",
      ...params.argv.map((argument) => argument.replaceAll("$", () => "$$")),
    ],
    {
      env: helperEnv,
      initiateSpawn: params.initiateSpawn,
      assertCurrent: params.assertCurrent,
    },
  );
  if (result.exitCode !== 0) {
    throw failure();
  }
  return { unitName };
}

async function readDurableProcess(unit: string): Promise<DurableProcessObservation> {
  const reply = await control(
    [
      "show",
      "--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,ExecMainCode,ExecMainStatus,Result",
    ],
    unit,
  );
  const fields = parseKeyValueOutput(reply.stdout, "=");
  if (fields.loadstate === "not-found") {
    return { state: "missing" };
  }
  if (reply.exitCode !== 0 || fields.loadstate !== "loaded") {
    throw failure();
  }
  const group = fields.controlgroup;
  const cgroupDirectory =
    group?.startsWith("/") && !group.split("/").includes("..")
      ? path.join("/sys/fs/cgroup", group)
      : undefined;
  if (
    ["activating", "deactivating", "reloading"].includes(fields.activestate ?? "") ||
    (fields.activestate === "active" && fields.substate !== "exited")
  ) {
    return {
      state: "running",
      pid: Number(fields.mainpid) || undefined,
      ...(cgroupDirectory ? { cgroupDirectory } : {}),
    };
  }
  const code = Number(fields.execmaincode),
    status = Number(fields.execmainstatus),
    signaled = code === 2 || code === 3;
  const reason =
    EXIT_REASONS[fields.result ?? ""] ??
    (signaled ? "signal" : code === 1 ? "exit" : "spawn-error");
  // An active/exited unit still holds what the command left running.
  const procs = cgroupDirectory
    ? await readFile(path.join(cgroupDirectory, "cgroup.procs"), "utf8").catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return "";
      })
    : "";
  const pids = new Set(procs.split("\n").filter(Boolean).map(Number));
  return {
    state: "exited",
    exitCode: code === 1 ? status : null,
    exitSignal: signaled ? status : null,
    reason,
    result: fields.result ?? "unknown",
    survivors: pids.size === 0 ? [] : describeLiveProcesses((row) => pids.has(row.pid)),
  };
}

async function stopDurableProcess(unit: string, options?: StopOptions): Promise<void> {
  if ((await control(["stop"], unit, options)).exitCode !== 0) {
    throw failure();
  }
}

/** The registry records the real result before releasing systemd's retained unit. */
async function cleanupDurableProcess(unit: string, options?: StopOptions): Promise<void> {
  const observed = await readDurableProcess(unit);
  // Stopping the unit would kill what the command left running; a later cleanup releases it.
  if (observed.state === "exited" && observed.survivors?.length !== 0) {
    return;
  }
  for (const action of ["stop", "reset-failed"]) {
    if (
      (await control([action], unit, options)).exitCode !== 0 &&
      (await readDurableProcess(unit)).state !== "missing"
    ) {
      throw failure();
    }
  }
}

export const systemdDurableSupervisor: DurableProcessSupervisor = {
  unitName: durableProcessUnitName,
  requireHost: requireDurableProcessHost,
  launch: launchDurableProcess,
  read: readDurableProcess,
  stop: stopDurableProcess,
  cleanup: cleanupDurableProcess,
};
