import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createWindowsJobBindings } from "../../src/process/supervisor/service-child-windows-job-native.ts";

const require = createRequire(import.meta.url);
let native: ReturnType<typeof createWindowsJobBindings> | undefined;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const CLEANUP_TIMEOUT_MS = 5_000;

type Result = {
  pid: number;
  status: number | null;
  signal: null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  processTreeState: "terminated" | "indeterminate";
};

/** Preserve the synchronous inventory API while owning a cmd shim's entire Job. */
export function runNpmWindowsJob(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Result {
  if (
    process.platform !== "win32" ||
    args.length !== 4 ||
    args.slice(0, 3).join(" ") !== "/d /s /c"
  ) {
    throw new Error("Expected the resolved Windows npm cmd invocation");
  }
  // Koffi and its native types are loaded once, only on the cmd fallback path.
  native ??= createWindowsJobBindings(require("koffi"));
  const b = native;
  b.assertLayouts();
  const result: Result = {
    pid: 0,
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    processTreeState: "terminated",
  };
  let job: bigint | undefined;
  let root: bigint | undefined;
  let stdio: ReturnType<typeof b.createCommandStdio> | undefined;
  let extinct = true;
  let rootExited = true;
  let settled = true;
  let terminationRequested = false;
  let cleanupDeadline: number | undefined;
  const streams: Array<{
    name: "stdout" | "stderr";
    handle: bigint;
    chunks: Buffer[];
    bytes: number;
    ended: boolean;
  }> = [];
  const buffer = Buffer.alloc(64 * 1024);
  const rememberError = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!result.error) {
      result.error = error;
    } else {
      Object.assign(result.error, { cleanupError: error });
    }
  };
  const observeJob = () => {
    if (!job) {
      return true;
    }
    const accounting: { ActiveProcesses?: unknown } = {};
    if (!b.QueryInformationJobObject(job, 1, accounting, b.basicAccountingSize, null)) {
      throw b.lastError("QueryInformationJobObject(npm)");
    }
    const count = accounting.ActiveProcesses;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid npm Job active process count");
    }
    return count === 0;
  };
  const readOutput = (capture: boolean) => {
    for (const stream of streams) {
      if (stream.ended) {
        continue;
      }
      const available = [0];
      if (!b.PeekNamedPipe(stream.handle, null, 0, null, available, null)) {
        if (b.getLastErrorCode() === 109) {
          stream.ended = true;
          continue;
        }
        throw b.lastError(`PeekNamedPipe(npm ${stream.name})`);
      }
      const amount = Math.min(available[0] ?? 0, buffer.length);
      if (amount === 0) {
        continue;
      }
      const read = [0];
      if (!b.ReadFile(stream.handle, buffer, amount, read, null)) {
        throw b.lastError(`ReadFile(npm ${stream.name})`);
      }
      const count = read[0];
      if (typeof count !== "number" || count <= 0 || count > amount) {
        throw new Error("Invalid npm output byte count");
      }
      if (!capture) {
        continue;
      }
      if (stream.bytes + count > options.maxBuffer) {
        throw Object.assign(new Error("npm output limit exceeded"), { code: "ENOBUFS" });
      }
      stream.chunks.push(Buffer.from(buffer.subarray(0, count)));
      stream.bytes += count;
    }
  };
  const terminateAndJoin = () => {
    if (!job || settled) {
      return;
    }
    cleanupDeadline ??= performance.now() + CLEANUP_TIMEOUT_MS;
    if (!extinct && !terminationRequested) {
      terminationRequested = true;
      if (!b.TerminateJobObject(job, 1)) {
        throw b.lastError("TerminateJobObject(npm)");
      }
    }
    // Job accounting can reach zero before a terminated root is signalled or its
    // inherited pipe handles close. Do not publish settlement at that boundary.
    while (true) {
      extinct = observeJob();
      if (root && !rootExited) {
        const state = b.WaitForSingleObject(root, 0);
        if (state === 0) {
          rootExited = true;
        } else if (state !== 258) {
          throw b.lastError("WaitForSingleObject(npm cleanup)");
        }
      }
      readOutput(!result.error);
      if (extinct && rootExited && streams.every((stream) => stream.ended)) {
        settled = true;
        return;
      }
      if (performance.now() >= cleanupDeadline) {
        throw new Error("npm Job resource settlement could not be verified");
      }
      Atomics.wait(waitCell, 0, 0, 5);
    }
  };
  try {
    const environment = new Map<string, string>();
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) {
        continue;
      }
      if (key.includes("\0") || value.includes("\0")) {
        throw new Error("NUL in npm environment");
      }
      environment.set(key.toUpperCase(), `${key}=${value}`);
    }
    const envBlock = Buffer.from(
      `${[...environment]
        .toSorted(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0))
        .map(([, value]) => value)
        .join("\0")}\0\0`,
      "utf16le",
    );
    job = b.requireHandle(b.CreateJobObjectW(null, null), "CreateJobObjectW(npm)");
    if (!b.SetExtendedLimits(job, 9, b.extendedLimits, b.extendedLimitsSize)) {
      throw b.lastError("SetInformationJobObject(npm)");
    }
    stdio = b.createCommandStdio();
    const attributes = b.createProcessAttributeList(stdio.inheritedHandles, job);
    const info: Record<string, unknown> = {};
    const deadline = performance.now() + options.timeout;
    try {
      if (
        !b.CreateProcessW(
          command,
          Buffer.from(`"${command}" ${args.join(" ")}\0`, "utf16le"),
          null,
          null,
          1,
          0x0000_0200 | 0x0000_0400 | 0x0008_0000 | 0x0800_0000,
          envBlock,
          options.cwd,
          {
            StartupInfo: {
              cb: b.startupInfoExSize,
              dwFlags: 0x100,
              hStdInput: stdio.stdinHandle,
              hStdOutput: stdio.stdoutWriteHandle,
              hStdError: stdio.stderrWriteHandle,
            },
            lpAttributeList: attributes.attributeList,
          },
          info,
        )
      ) {
        throw b.lastError("CreateProcessW(npm JOB_LIST)");
      }
      // JOB_LIST makes containment atomic; numeric PIDs never grant cleanup authority.
      extinct = false;
      rootExited = false;
      settled = false;
      root = b.requireHandle(info.hProcess, "CreateProcessW(npm process)");
      const thread = b.requireHandle(info.hThread, "CreateProcessW(npm thread)");
      if (!b.CloseHandle(thread)) {
        throw b.lastError("CloseHandle(npm thread)");
      }
      if (typeof info.dwProcessId === "number") {
        result.pid = info.dwProcessId;
      }
    } finally {
      attributes.release();
      stdio.closeChildHandles();
    }
    const output = stdio.takeOutputReadHandles();
    streams.push(
      { name: "stdout", handle: output.stdoutReadHandle, chunks: [], bytes: 0, ended: false },
      { name: "stderr", handle: output.stderrReadHandle, chunks: [], bytes: 0, ended: false },
    );
    while (!rootExited || !extinct || streams.some((stream) => !stream.ended)) {
      readOutput(true);
      if (!rootExited) {
        const state = b.WaitForSingleObject(root, 0);
        if (state === 0) {
          const code = [0];
          if (!b.GetExitCodeProcess(root, code)) {
            throw b.lastError("GetExitCodeProcess(npm)");
          }
          result.status = code[0] ?? null;
          rootExited = true;
          // A finished shim cannot leave background writers behind its result.
          extinct = observeJob();
          terminateAndJoin();
        } else if (state !== 258) {
          throw b.lastError("WaitForSingleObject(npm)");
        }
      }
      if (!rootExited && performance.now() >= deadline) {
        throw Object.assign(new Error("npm command deadline expired"), { code: "ETIMEDOUT" });
      }
      if (!rootExited || !extinct || streams.some((stream) => !stream.ended)) {
        Atomics.wait(waitCell, 0, 0, 5);
      }
    }
  } catch (error) {
    rememberError(error);
  } finally {
    try {
      terminateAndJoin();
    } catch (error) {
      rememberError(error);
    }
    result.processTreeState = settled ? "terminated" : "indeterminate";
    for (const stream of streams) {
      result[stream.name] = Buffer.concat(stream.chunks).toString("utf8");
      if (!b.CloseHandle(stream.handle)) {
        rememberError(b.lastError(`CloseHandle(npm ${stream.name})`));
      }
    }
    stdio?.close();
    for (const handle of [root, job]) {
      if (handle !== undefined && !b.CloseHandle(handle)) {
        rememberError(b.lastError("CloseHandle(npm owner)"));
      }
    }
  }
  return result;
}
