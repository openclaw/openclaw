// Parent-side subprocess boundary for synchronous sqlite-vec KNN work.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ensureSqliteLibrarySelected,
  SQLITE_IDLE_HANDLE_TTL_MS,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { vectorKnnProcessEntrypoint } from "./manager-search-knn-entrypoint.js";
import type { VectorKnnChildInput } from "./manager-search-knn.child.js";
import {
  isVectorKnnRow,
  type VectorKnnRequest,
  type VectorKnnResponse,
} from "./manager-search-knn.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_EXIT_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_VECTOR_KNN_CHILDREN = 2;

class VectorKnnSubprocessError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "failed" | "protocol" | "termination-timeout",
  ) {
    super(message);
    this.name = "VectorKnnSubprocessError";
  }
}

function buildChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (env[name]) {
      childEnv[name] = env[name];
    }
  }
  return childEnv;
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("memory vector KNN aborted");
}

function createVectorKnnAdmission(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<{
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }> = [];

  const releaseNext = (): void => {
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      next.signal?.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) {
        next.reject(toAbortError(next.signal));
        continue;
      }
      next.resolve(createRelease());
      return;
    }
    active -= 1;
  };
  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseNext();
    };
  };

  return {
    get full() {
      return active >= maxConcurrent;
    },
    get waiting() {
      return waiters.length > 0;
    },
    acquire: async (signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw toAbortError(signal);
      }
      if (active < maxConcurrent) {
        active += 1;
        return createRelease();
      }
      return await new Promise<() => void>((resolve, reject) => {
        const waiter = {
          signal,
          resolve,
          reject,
          abort: () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(toAbortError(signal!));
          },
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        if (signal?.aborted) {
          waiter.abort();
        }
      });
    },
  };
}

const vectorKnnAdmission = createVectorKnnAdmission(MAX_CONCURRENT_VECTOR_KNN_CHILDREN);
const databaseAdmissions = new Map<
  string,
  { admission: ReturnType<typeof createVectorKnnAdmission>; users: number }
>();
const children = new Map<
  string,
  {
    child: ChildProcessWithoutNullStreams;
    idleTimer?: ReturnType<typeof setTimeout>;
    retire: () => void;
    requestId: number;
  }
>();

function setChildReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean) {
  const method = referenced ? "ref" : "unref";
  child[method]();
  for (const pipe of [child.stdin, child.stdout, child.stderr]) {
    // Node and Bun expose different pipe classes and optional ref methods.
    if (referenced && "ref" in pipe && typeof pipe.ref === "function") {
      pipe.ref();
    }
    if (!referenced && "unref" in pipe && typeof pipe.unref === "function") {
      pipe.unref();
    }
  }
}

function parseChildResult(output: Buffer, maxRows: number, id: number): VectorKnnResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned malformed JSON",
      "protocol",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("status" in parsed) ||
    !("id" in parsed) ||
    parsed.id !== id
  ) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid envelope",
      "protocol",
    );
  }
  if (parsed.status === "failed" && "error" in parsed && typeof parsed.error === "string") {
    throw new VectorKnnSubprocessError(parsed.error || "memory vector KNN child failed", "failed");
  }
  const value = "value" in parsed ? parsed.value : undefined;
  if (
    parsed.status !== "ok" ||
    !value ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows) ||
    value.rows.length > maxRows ||
    !value.rows.every(isVectorKnnRow) ||
    !("fallbackScanRequired" in value) ||
    typeof value.fallbackScanRequired !== "boolean"
  ) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid result",
      "protocol",
    );
  }
  return { rows: value.rows, fallbackScanRequired: value.fallbackScanRequired };
}

type VectorKnnSubprocessParams = {
  databasePath: string;
  extensionPath?: string;
  request: VectorKnnRequest;
  signal?: AbortSignal;
};

/** Run one file-backed KNN query in a bounded, OS-killable child process. */
export async function runVectorKnnInSubprocess(
  params: VectorKnnSubprocessParams,
): Promise<VectorKnnResponse> {
  let entry = databaseAdmissions.get(params.databasePath);
  if (!entry) {
    entry = { admission: createVectorKnnAdmission(1), users: 0 };
    databaseAdmissions.set(params.databasePath, entry);
  }
  entry.users += 1;
  let release: (() => void) | undefined;
  try {
    release = await entry.admission.acquire(params.signal);
    return await runAdmittedVectorKnn(params);
  } finally {
    release?.();
    if (--entry.users === 0) {
      databaseAdmissions.delete(params.databasePath);
    }
  }
}

async function runAdmittedVectorKnn(params: VectorKnnSubprocessParams): Promise<VectorKnnResponse> {
  if (params.signal?.aborted) {
    throw toAbortError(params.signal);
  }
  const sqliteLibrary = ensureSqliteLibrarySelected();
  const input: VectorKnnChildInput = {
    id: (children.get(params.databasePath)?.requestId ?? 0) + 1,
    databasePath: params.databasePath,
    extensionPath: params.extensionPath,
    ...(sqliteLibrary.source !== "runtime" ? { sqliteLibraryPath: sqliteLibrary.path } : {}),
    request: params.request,
  };
  const inputPayload = Buffer.from(JSON.stringify(input), "utf8");
  if (inputPayload.byteLength > MAX_STDIN_BYTES) {
    throw new VectorKnnSubprocessError("memory vector KNN child input is too large", "protocol");
  }

  let worker = children.get(params.databasePath);
  if (!worker) {
    if (vectorKnnAdmission.full) {
      const idleWorker = [...children.values()].find((candidate) => candidate.idleTimer);
      if (idleWorker) {
        idleWorker.retire();
      }
    }
    const releaseAdmission = await vectorKnnAdmission.acquire(params.signal);
    if (params.signal?.aborted) {
      releaseAdmission();
      throw toAbortError(params.signal);
    }
    let child;
    try {
      const childUrl = resolveRuntimeWorkerUrl(vectorKnnProcessEntrypoint);
      child = spawn(process.execPath, resolveRuntimeWorkerArgv(childUrl), {
        env: buildChildEnv(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      releaseAdmission();
      throw new VectorKnnSubprocessError(
        error instanceof Error ? error.message : String(error),
        "unavailable",
      );
    }
    worker = {
      child,
      requestId: 0,
      retire: () => {
        if (children.get(params.databasePath) !== ownedWorker) {
          return;
        }
        // A waiter can arrive after any retirement, including the idle timer.
        setChildReferenced(child, true);
        children.delete(params.databasePath);
        clearTimeout(ownedWorker.idleTimer);
        child.stdin.destroy();
        child.kill("SIGKILL");
      },
    };
    const ownedWorker = worker;
    child.once("close", () => {
      clearTimeout(ownedWorker.idleTimer);
      if (children.get(params.databasePath) === ownedWorker) {
        children.delete(params.databasePath);
      }
      releaseAdmission();
    });
    child.on("error", ownedWorker.retire);
    child.stdin.on("error", ownedWorker.retire);
    children.set(params.databasePath, worker);
  }
  const { child } = worker;
  const ownedWorker = worker;
  worker.requestId = input.id;
  clearTimeout(worker.idleTimer);
  worker.idleTimer = undefined;
  child.stdout.removeAllListeners("data");
  setChildReferenced(child, true);
  return await new Promise<VectorKnnResponse>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let closed = false;
    let callerSettled = false;
    let terminationReason: Error | undefined;
    let killExitTimer: ReturnType<typeof setTimeout> | undefined;

    const clearKillExitTimer = () => {
      if (killExitTimer) {
        clearTimeout(killExitTimer);
        killExitTimer = undefined;
      }
    };
    const settleCaller = (action: () => void) => {
      if (callerSettled) {
        return;
      }
      callerSettled = true;
      params.signal?.removeEventListener("abort", abort);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.stdin.removeListener("error", onStdinError);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      action();
    };
    const releaseClosedChild = () => {
      clearKillExitTimer();
      params.signal?.removeEventListener("abort", abort);
    };
    const requestTermination = (reason: Error) => {
      if (terminationReason || closed) {
        return;
      }
      terminationReason = reason;
      // This read-only Node child creates no descendants. Kill the owned handle:
      // native SQLite cannot service graceful shutdown while its query is busy.
      ownedWorker.retire();
      killExitTimer = setTimeout(() => {
        if (!closed) {
          // The caller may return, but this child keeps its admission slot until
          // close. Destroying pipes and unref'ing prevents one unkillable OS task
          // from pinning the Gateway while the slot bounds future accumulation.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settleCaller(() =>
            reject(
              new VectorKnnSubprocessError(
                "memory vector KNN child did not exit after SIGKILL",
                "termination-timeout",
              ),
            ),
          );
        }
      }, KILL_EXIT_TIMEOUT_MS);
    };
    const abort = () => {
      requestTermination(toAbortError(params.signal!));
    };

    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) {
      abort();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES + (chunk[chunk.length - 1] === 10 ? 1 : 0)) {
        const failure = new VectorKnnSubprocessError(
          "memory vector KNN child stdout exceeded its limit",
          "protocol",
        );
        stdoutChunks.length = 0;
        requestTermination(failure);
        return;
      }
      stdoutChunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) {
        return;
      }
      try {
        if (newline !== chunk.length - 1) {
          throw new VectorKnnSubprocessError(
            "memory vector KNN child returned extra output",
            "protocol",
          );
        }
        const result = parseChildResult(
          Buffer.concat(stdoutChunks),
          params.request.limit,
          input.id,
        );
        if (terminationReason) {
          return;
        }
        settleCaller(() => resolve(result));
        child.stdout.on("data", ownedWorker.retire);
        ownedWorker.idleTimer = setTimeout(ownedWorker.retire, SQLITE_IDLE_HANDLE_TTL_MS);
        ownedWorker.idleTimer.unref();
        if (vectorKnnAdmission.waiting) {
          ownedWorker.retire();
        } else {
          setChildReferenced(child, false);
        }
      } catch (error) {
        requestTermination(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        const failure = new VectorKnnSubprocessError(
          "memory vector KNN child stderr exceeded its limit",
          "protocol",
        );
        requestTermination(failure);
        return;
      }
      stderrChunks.push(chunk);
    });
    const onStdinError = (error: NodeJS.ErrnoException) => {
      if (!terminationReason && error.code !== "EPIPE") {
        requestTermination(new VectorKnnSubprocessError(error.message, "failed"));
      }
    };
    child.stdin.on("error", onStdinError);
    const onError = (error: Error) => {
      requestTermination(new VectorKnnSubprocessError(error.message, "unavailable"));
    };
    child.once("error", onError);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      // close is the authoritative process/stdio completion; a recycled numeric
      // PID must not turn a successful query into a false cleanup failure.
      releaseClosedChild();
      settleCaller(() => {
        if (terminationReason) {
          reject(terminationReason);
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new VectorKnnSubprocessError(
            `memory vector KNN child exited before returning a result (code ${code}, signal ${signal ?? "none"})${stderr ? `: ${stderr}` : ""}`,
            "failed",
          ),
        );
      });
    };
    child.once("close", onClose);
    child.stdin.write(Buffer.concat([inputPayload, Buffer.from("\n")]));
  });
}
