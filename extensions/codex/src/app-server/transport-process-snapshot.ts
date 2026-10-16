import { execFile } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import {
  DarwinProcessInspectionError,
  readDarwinProcessSnapshot,
  readDarwinProcessTree,
  readDarwinProcessCommandLine,
} from "openclaw/plugin-sdk/process-runtime";

export type PosixProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  startedAt: string;
};

/** A zombie leader can still own running threads, reported by the ps-style l flag. */
export function isDeadProcessState(state: string): boolean {
  return state.startsWith("Z") && !state.includes("l");
}

const PROCESS_COLUMNS = "pid=,ppid=,pgid=,stat=,lstart=";
const MAX_PROCESS_CONTAINMENT_MS = 2_000;
const PROCESS_INSPECTION_MAX_BYTES = 8 * 1024 * 1024;
const PROCFS_COMMAND_PERMISSION_EXIT = 77;
// Keep cmdline kernel waits and whole-table filesystem work outside the Gateway.
const PROCFS_READER = `
const fs = require("node:fs");
const [target, limit] = process.argv.slice(-2);
const maxBytes = Number(limit);
const buffer = Buffer.alloc(4096);
let bytes = 0;
function read(file) {
  const fd = fs.openSync(file, "r");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null);
      if (count === 0) break;
      bytes += count;
      if (bytes > maxBytes) throw new Error("Process inspection byte limit exceeded");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      size += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.concat(chunks, size);
}
try {
  if (target === "snapshot") {
    const rows = [read("/proc/sys/kernel/random/boot_id").toString()];
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\\d+$/.test(pid)) continue;
      try {
        rows.push(pid, read("/proc/" + pid + "/stat").toString());
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
      }
    }
    process.stdout.end(rows.join("\\0"));
  } else {
    process.stdout.end(read("/proc/" + target + "/cmdline"));
  }
} catch (error) {
  process.exitCode = ["EACCES", "EPERM", "ERR_ACCESS_DENIED"].includes(error?.code)
    ? ${PROCFS_COMMAND_PERMISSION_EXIT} : 1;
}
`;

export class ProcessInspectionError extends Error {
  constructor(readonly reason: "deadline" | "permission" | "unavailable") {
    const detail = {
      deadline: "Process inspection exceeded its deadline. Retry when the host is responsive.",
      permission:
        "Check process inspection permissions (/proc on Linux, native process inspection on macOS), then retry.",
      unavailable:
        "Process identity is unavailable or invalid. Check /proc on Linux or native process inspection on macOS, then retry.",
    }[reason];
    super(`Cannot inspect Codex processes. ${detail}`);
    this.name = "ProcessInspectionError";
  }
}

function remainingInspectionTime(deadline: number): number {
  // Use the monotonic clock so NTP adjustments or sleep resumes cannot stretch
  // or shrink the budget while the inspection timers (also monotonic) are in flight.
  // Math.floor keeps the value integral for AbortSignal.timeout / setTimeout.
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) {
    throw new ProcessInspectionError("deadline");
  }
  return remainingMs;
}

function inspectionFailure(error: unknown): ProcessInspectionError {
  if (error instanceof DarwinProcessInspectionError) {
    return new ProcessInspectionError(error.reason);
  }
  if (error instanceof ProcessInspectionError) {
    return error;
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  // Every abort signal in this reader is owned by its inspection deadline.
  return new ProcessInspectionError(
    code === "ABORT_ERR"
      ? "deadline"
      : code === "EACCES" || code === "EPERM" || code === "ERR_ACCESS_DENIED"
        ? "permission"
        : "unavailable",
  );
}

function isMissingProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

export async function readCodexAppServerProcessSnapshot(
  deadline = performance.now() + MAX_PROCESS_CONTAINMENT_MS,
  pids?: readonly number[],
  treeRoots?: readonly number[],
): Promise<PosixProcess[]> {
  // Registration proves only known owners. Containment still needs the full tree.
  // Include the observer so an empty selected ps result cannot prove disappearance.
  const selected = pids === undefined ? undefined : [...new Set([process.pid, ...pids])];
  const rows =
    treeRoots && process.platform === "darwin"
      ? await readDarwinProcessTree(deadline, treeRoots).catch((error: unknown) => {
          throw inspectionFailure(error);
        })
      : await readProcesses(selected, deadline, selected !== undefined);
  if ((selected || treeRoots) && !rows.some((row) => row.pid === process.pid)) {
    throw new ProcessInspectionError("unavailable");
  }
  return rows;
}

export async function readCodexAppServerProcess(
  pid: number,
  deadline: number,
): Promise<PosixProcess | undefined> {
  const rows = await readProcesses([pid], deadline);
  return rows.find((row) => row.pid === pid);
}

export async function readCodexAppServerProcessCommand(
  observed: PosixProcess,
  deadline: number,
): Promise<string> {
  let output: string;
  if (process.platform === "linux") {
    let pending = false;
    do {
      remainingInspectionTime(deadline);
      const command = await readProcessOutput(
        { kind: "procfs-command", pid: observed.pid },
        deadline,
      );
      // Linux can expose zero command bytes during exec startup. Wait only for
      // that state, with the original identity and deadline, including the final read.
      if (!command || pending) {
        const current = await readCodexAppServerProcess(observed.pid, deadline);
        if (
          !current ||
          current.startedAt !== observed.startedAt ||
          current.ppid !== observed.ppid ||
          current.pgid !== observed.pgid ||
          current.state.startsWith("Z")
        ) {
          throw new ProcessInspectionError("unavailable");
        }
      }
      output = command.split("\0").join(" ").trim();
      pending = command.length === 0;
      if (pending) {
        await setImmediate();
      }
    } while (pending);
  } else if (process.platform === "darwin") {
    output = await readDarwinProcessCommandLine(observed.pid, deadline).catch((error: unknown) => {
      throw inspectionFailure(error);
    });
  } else {
    output =
      (
        await readProcessOutput(
          { kind: "ps", args: ["-o", "command=", "-p", String(observed.pid)] },
          deadline,
        )
      )
        .split("\n")[0]
        ?.trim() ?? "";
  }
  remainingInspectionTime(deadline);
  if (!output) {
    throw new ProcessInspectionError("unavailable");
  }
  return output;
}

function readProcesses(
  pids: readonly number[] | undefined,
  deadline: number,
  selected = false,
): Promise<PosixProcess[]> {
  if (process.platform === "linux") {
    return readLinuxProcesses(pids, deadline);
  }
  if (process.platform === "darwin") {
    return readDarwinProcessSnapshot(deadline, pids)
      .then((rows) =>
        rows.map(({ pid, ppid, pgid, state, startedAt }) => ({
          pid,
          ppid,
          pgid,
          state,
          startedAt,
        })),
      )
      .catch((error: unknown) => {
        throw inspectionFailure(error);
      });
  }
  const args = pids ? ["-o", PROCESS_COLUMNS, "-p", pids.join(",")] : ["-axo", PROCESS_COLUMNS];
  return readProcessOutput({ kind: "ps", args }, deadline).then((output) =>
    parseProcesses(output, selected),
  );
}

async function readProcessOutput(
  command:
    | { kind: "ps"; args: string[] }
    | { kind: "procfs-command"; pid: number }
    | { kind: "procfs-snapshot" },
  deadline: number,
): Promise<string> {
  const remainingMs = remainingInspectionTime(deadline);
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (output: string | ProcessInspectionError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (output instanceof ProcessInspectionError) {
        reject(output);
      } else {
        resolve(output);
      }
    };
    const procfs = command.kind !== "ps";
    const inspector = execFile(
      procfs ? process.execPath : "ps",
      procfs
        ? [
            ...(process.versions.bun ? ["--no-env-file", "--config=/dev/null"] : []),
            "-e",
            PROCFS_READER,
            command.kind === "procfs-command" ? String(command.pid) : "snapshot",
            String(PROCESS_INSPECTION_MAX_BYTES),
          ]
        : command.args,
      {
        encoding: "utf8",
        maxBuffer: PROCESS_INSPECTION_MAX_BYTES,
        // Runtime helpers must not load ambient preloads or project configuration.
        cwd: procfs ? "/" : undefined,
        env: procfs ? {} : { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        settle(
          performance.now() >= deadline
            ? new ProcessInspectionError("deadline")
            : error
              ? procfs && error.code === PROCFS_COMMAND_PERMISSION_EXIT
                ? new ProcessInspectionError("permission")
                : inspectionFailure(error)
              : stdout,
        );
      },
    );
    const timer = setTimeout(
      () => {
        settle(new ProcessInspectionError("deadline"));
        inspector.stdout?.destroy();
        inspector.stderr?.destroy();
        inspector.kill("SIGKILL");
        inspector.unref();
      },
      Math.max(1, remainingMs),
    );
    timer.unref?.();
  }).catch((error: unknown) => {
    // Spawn denial can throw before the inspector or its callback exists.
    throw inspectionFailure(error);
  });
}

function parseProcesses(output: string, selected: boolean): PosixProcess[] {
  const rows: PosixProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
      if (selected && line.trim()) {
        throw new ProcessInspectionError("unavailable");
      }
      continue;
    }
    const pid = Number(match[1] ?? "");
    const ppid = Number(match[2] ?? "");
    const pgid = Number(match[3] ?? "");
    const startedAt = (match[5] ?? "").trim().replace(/\s+/g, " ");
    if (
      ![pid, ppid, pgid].every(Number.isSafeInteger) ||
      pid <= 0 ||
      ppid < 0 ||
      pgid <= 0 ||
      !startedAt
    ) {
      if (selected) {
        throw new ProcessInspectionError("unavailable");
      }
      continue;
    }
    rows.push({ pid, ppid, pgid, state: match[4] ?? "", startedAt });
  }
  return rows;
}

// Linux exposes stronger start identities in procfs; BusyBox ps on supported
// Alpine installs has no lstart. Boot identity prevents reuse across reboots.
async function readLinuxProcesses(
  selected: readonly number[] | undefined,
  deadline: number,
): Promise<PosixProcess[]> {
  if (selected !== undefined) {
    return readSelectedLinuxProcesses(selected, deadline);
  }
  const output = await readProcessOutput({ kind: "procfs-snapshot" }, deadline);
  // procfs comm may contain newlines and ')', but never a NUL byte.
  const [boot, ...fields] = output.split("\0");
  const bootId = parseLinuxBootId(boot ?? "");
  const rows: PosixProcess[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const row = parseLinuxProcess(fields[index + 1]!, fields[index]!, bootId, false);
    if (row) {
      rows.push(row);
    }
  }
  remainingInspectionTime(deadline);
  return rows;
}

function parseLinuxBootId(value: string): string {
  const bootId = value.trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId)) {
    throw new ProcessInspectionError("unavailable");
  }
  return bootId;
}

function parseLinuxProcess(
  stat: string,
  entry: string,
  bootId: string,
  selected: boolean,
): PosixProcess | undefined {
  // comm can contain spaces, newlines and ')'; fields 3..N follow its last ')'.
  const commEnd = stat.lastIndexOf(")");
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/, 20);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTicks = fields[19];
  if (
    commEnd < 0 ||
    ![ppid, pgid].every(Number.isSafeInteger) ||
    (selected && (pgid <= 0 || ppid < 0)) ||
    !/^\d+$/.test(startTicks ?? "")
  ) {
    throw new ProcessInspectionError("unavailable");
  }
  // An exiting task can lose its signal lock and report pgid=-1, threads=0.
  // Full scans omit that row; selected owners still require usable group evidence.
  if (pgid > 0) {
    const threads = Number(fields[17]);
    if (!/^[1-9]\d*$/.test(fields[17] ?? "") || !Number.isSafeInteger(threads)) {
      throw new ProcessInspectionError("unavailable");
    }
    return {
      pid: Number(entry),
      ppid,
      pgid,
      state: `${fields[0]}${threads > 1 ? "l" : ""}`,
      startedAt: `${bootId}:${startTicks}`,
    };
  }
  return undefined;
}

/** Known procfs identities must not queue behind unrelated libuv filesystem work. */
function readSelectedProcFile(
  file: string,
  deadline: number,
  maxBytes = PROCESS_INSPECTION_MAX_BYTES,
): Buffer {
  remainingInspectionTime(deadline);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(Math.min(4096, maxBytes + 1));
  let bytes = 0;
  try {
    for (;;) {
      remainingInspectionTime(deadline);
      const count = readSync(fd, buffer, {
        offset: 0,
        length: Math.min(buffer.length, maxBytes - bytes + 1),
        position: null,
      });
      remainingInspectionTime(deadline);
      if (count === 0) {
        return Buffer.concat(chunks, bytes);
      }
      bytes += count;
      if (bytes > maxBytes) {
        throw new ProcessInspectionError("unavailable");
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally {
    closeSync(fd);
  }
}

function readSelectedLinuxProcesses(selected: readonly number[], deadline: number): PosixProcess[] {
  try {
    const bootId = parseLinuxBootId(
      readSelectedProcFile("/proc/sys/kernel/random/boot_id", deadline).toString("utf8"),
    );
    const rows: PosixProcess[] = [];
    let bytes = 0;
    for (const entry of selected.map(String)) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      let stat: Buffer;
      try {
        stat = readSelectedProcFile(
          `/proc/${entry}/stat`,
          deadline,
          PROCESS_INSPECTION_MAX_BYTES - bytes,
        );
      } catch (error) {
        if (isMissingProcess(error)) {
          continue;
        }
        throw error;
      }
      bytes += stat.length;
      const row = parseLinuxProcess(stat.toString("utf8"), entry, bootId, true);
      if (row) {
        rows.push(row);
      }
    }
    remainingInspectionTime(deadline);
    return rows;
  } catch (error) {
    throw inspectionFailure(error);
  }
}
