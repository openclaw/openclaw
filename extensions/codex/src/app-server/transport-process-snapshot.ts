import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import {
  DarwinProcessInspectionError,
  readDarwinProcessSnapshot,
  readDarwinProcessTree,
  readDarwinProcessCommandLine,
} from "openclaw/plugin-sdk/process-runtime";
import { withTimeout } from "./timeout.js";

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
      const command = await readProcFile(`/proc/${observed.pid}/cmdline`, deadline).catch(
        (error: unknown) => {
          throw inspectionFailure(error);
        },
      );
      // Linux can expose zero command bytes during exec startup. Wait only for
      // that state, with the original identity and deadline, including the final read.
      if (command.length === 0 || pending) {
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
      output = command.toString("utf8").split("\0").join(" ").trim();
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
      (await readProcessOutput(["-o", "command=", "-p", String(observed.pid)], deadline))
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
  return readProcessOutput(args, deadline).then((output) => parseProcesses(output, selected));
}

async function readProcessOutput(args: string[], deadline: number): Promise<string> {
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
    const inspector = execFile(
      "ps",
      args,
      {
        encoding: "utf8",
        maxBuffer: PROCESS_INSPECTION_MAX_BYTES,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        settle(
          performance.now() >= deadline
            ? new ProcessInspectionError("deadline")
            : error
              ? inspectionFailure(error)
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
  try {
    const bootId = parseLinuxBootId(
      (await readProcFile("/proc/sys/kernel/random/boot_id", deadline)).toString("utf8"),
    );
    const entries = selected
      ? selected.map(String)
      : await withinInspectionDeadline(deadline, () => readdir("/proc"));
    const rows: PosixProcess[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      let stat: Buffer;
      try {
        stat = await readProcFile(
          `/proc/${entry}/stat`,
          deadline,
          PROCESS_INSPECTION_MAX_BYTES - bytes,
        );
      } catch (error) {
        // A process can exit between enumeration and read; denial never proves exit.
        if (isMissingProcess(error)) {
          continue;
        }
        throw error;
      }
      bytes += stat.length;
      const row = parseLinuxProcess(stat.toString("utf8"), entry, bootId, selected !== undefined);
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

/** A queued or blocked filesystem operation must not hold its caller past the deadline. */
async function withinInspectionDeadline<T>(deadline: number, read: () => Promise<T>): Promise<T> {
  const remainingMs = remainingInspectionTime(deadline);
  const value = await withTimeout(
    read(),
    remainingMs,
    "Process inspection deadline",
    () => new ProcessInspectionError("deadline"),
  );
  remainingInspectionTime(deadline);
  return value;
}

function readProcFile(
  file: string,
  deadline: number,
  maxBytes = PROCESS_INSPECTION_MAX_BYTES,
): Promise<Buffer> {
  // No runtime launch: procfs reads cannot load ambient preloads or project config.
  return withinInspectionDeadline(deadline, async () => {
    const handle = await open(file, "r");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(4096, maxBytes + 1));
    let bytes = 0;
    try {
      for (;;) {
        remainingInspectionTime(deadline);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, maxBytes - bytes + 1),
          null,
        );
        remainingInspectionTime(deadline);
        if (bytesRead === 0) {
          return Buffer.concat(chunks, bytes);
        }
        bytes += bytesRead;
        if (bytes > maxBytes) {
          throw new ProcessInspectionError("unavailable");
        }
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
    } finally {
      // A timed-out syscall can finish later; its descriptor still belongs to this read.
      await handle.close();
    }
  });
}
