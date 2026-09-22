import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runBestEffortCleanup } from "../infra/non-fatal-cleanup.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  WorkerTaskError,
  WorkerTaskPool,
  type WorkerTaskResponse,
} from "../infra/worker-task-pool.js";
import {
  codeModeFailureCode,
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
} from "./code-mode-errors.js";
import type {
  CodeModeExecutor,
  CodeModeExecutorContinuation,
  CodeModeExecutorResumeInput,
  CodeModeExecutorRunOptions,
  CodeModeExecutorStartInput,
  CodeModeFailureCode,
  CodeModeWorkerResult,
} from "./code-mode-executor-types.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerThreadResult,
} from "./code-mode-worker-types.js";

type NodePool = {
  tasks: WorkerTaskPool<NodeInput, CodeModeWorkerThreadResult<undefined>>;
  url: string;
  memoryLimitBytes: number;
};
type NodeInput = CodeModeExecutorStartInput | CodeModeExecutorResumeInput;
const retiringPools = new Set<NodePool>();
let idle: { owner: NodePool; timer: NodeJS.Timeout } | undefined;

async function closePool(owner: NodePool): Promise<void> {
  // Native slots retain custody until exit; keep their owner through pending or failed cleanup.
  retiringPools.add(owner);
  await owner.tasks.close();
  retiringPools.delete(owner);
}

async function takePool(memoryLimitBytes: number, signal: AbortSignal): Promise<NodePool> {
  signal.throwIfAborted();
  await Promise.all([...retiringPools].map(closePool));
  signal.throwIfAborted();
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.codeModeNode);
  const previous = idle;
  idle = undefined;
  if (previous) {
    clearTimeout(previous.timer);
    const owner = previous.owner;
    if (
      owner.memoryLimitBytes === memoryLimitBytes &&
      owner.url === workerUrl.href &&
      !owner.tasks.isClosed
    ) {
      return owner;
    }
    await closePool(owner);
    signal.throwIfAborted();
  }
  const owner: NodePool = {
    url: workerUrl.href,
    memoryLimitBytes,
    tasks: new WorkerTaskPool({
      workerUrl,
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      sharedCompute: true,
      onRetirementFailure: () => {
        retiringPools.add(owner);
      },
      workerOptions: {
        env: {},
        resourceLimits: {
          // V8 heap limits exclude ArrayBuffer/native allocations and are not an RSS boundary.
          maxOldGenerationSizeMb: Math.max(1, Math.floor(memoryLimitBytes / (1024 * 1024)) - 4),
          maxYoungGenerationSizeMb: 4,
        },
      },
    }),
  };
  return owner;
}

async function releasePool(owner: NodePool): Promise<void> {
  if (idle || owner.tasks.isClosed) {
    await closePool(owner);
    return;
  }
  const timer = setTimeout(() => {
    if (idle?.owner !== owner) {
      return;
    }
    idle = undefined;
    void runBestEffortCleanup({
      cleanup: () => closePool(owner),
      onError: (error) =>
        process.emitWarning(`Code Mode worker retirement failed: ${formatErrorMessage(error)}`),
    });
  }, 60_000);
  timer.unref();
  idle = { owner, timer };
}

function failure(
  error: unknown,
  code: CodeModeFailureCode,
): Extract<CodeModeWorkerResult, { status: "failed" }> {
  return {
    status: "failed",
    code,
    error: formatErrorMessage(error),
    failurePhase: "host",
    bridgeDispatchStarted: false,
    output: EMPTY_CODE_MODE_OUTPUT,
  };
}

function continuation(pool: NodePool): CodeModeExecutorContinuation {
  let state: "owned" | "resumed" | "disposing" | "disposed" = "owned";
  let closing: Promise<void> | undefined;
  return {
    executor: "node",
    // There is no serialized VM image; report the configured heap as a diagnostic estimate.
    retainedBytes: pool.memoryLimitBytes,
    resume(input, options) {
      if (state !== "owned") {
        return Promise.resolve(
          failure("code mode continuation is no longer available", "runtime_unavailable"),
        );
      }
      state = "resumed";
      return run(pool, input, options);
    },
    dispose() {
      if (state === "resumed" || state === "disposed") {
        return Promise.resolve();
      }
      state = "disposing";
      return (closing ??= closePool(pool)
        .then(() => {
          state = "disposed";
        })
        .finally(() => {
          closing = undefined;
        }));
    },
  };
}

async function run(
  pool: NodePool,
  input: NodeInput,
  options: CodeModeExecutorRunOptions,
  startedAt = performance.now(),
): Promise<CodeModeWorkerResult> {
  const inlineHost = options.inlineHost;
  let admittedTimeoutMs = 0;
  let retained = false;
  try {
    const preparationMs = performance.now() - startedAt;
    if (input.config.timeoutMs <= preparationMs || options.timeoutMs <= preparationMs) {
      throw new CodeModeHeadlessTimeoutError();
    }
    const result = await pool.tasks.run(
      () => {
        admittedTimeoutMs = Math.max(0, input.config.timeoutMs - (performance.now() - startedAt));
        if (admittedTimeoutMs <= 0) {
          throw new CodeModeHeadlessTimeoutError();
        }
        return { ...input, config: { ...input.config, timeoutMs: admittedTimeoutMs } };
      },
      {
        timeoutMs: options.timeoutMs - preparationMs,
        signal: options.signal,
        inputBytes: input.kind === "exec" ? input.source.length * 2 : 0,
        onInputConsumed: inlineHost?.onInputConsumed,
        onRequest: inlineHost
          ? async (value, context): Promise<WorkerTaskResponse> => {
              if (!isRecord(value) || value.status !== "boundary") {
                throw new Error("invalid code mode worker boundary");
              }
              if (!Number.isFinite(admittedTimeoutMs) || admittedTimeoutMs <= 0) {
                throw new Error("invalid code mode worker admission budget");
              }
              if (value.networkContentObserved === true) {
                inlineHost?.onNetworkContent?.();
              }
              const { onConsumed, ...command } = await inlineHost.onBoundary(
                // SAFETY: The private Node worker emits the shared typed boundary protocol.
                value as CodeModeWorkerBoundary,
                { ...context, maxTimeoutMs: admittedTimeoutMs },
              );
              return {
                input: command,
                onConsumed,
                timeoutMs:
                  (command.kind === "continue" ? command.timeoutMs : 0) +
                  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
              };
            }
          : undefined,
      },
    );
    if (result.networkContentObserved === true) {
      inlineHost?.onNetworkContent?.();
    }
    if (result.status === "waiting") {
      retained = true;
      return { ...result, continuation: continuation(pool) };
    }
    if (result.status === "completed") {
      await releasePool(pool);
      retained = true;
    }
    return result;
  } catch (error) {
    const reason = options.signal?.aborted ? options.signal.reason : error;
    if (
      reason instanceof CodeModeHeadlessTimeoutError ||
      (error instanceof WorkerTaskError && error.code === "timeout")
    ) {
      return failure("code mode timeout exceeded", "timeout");
    }
    if (options.signal?.aborted || reason instanceof CodeModeHeadlessAbortError) {
      return failure("code mode execution aborted", "aborted");
    }
    return failure(
      error,
      error instanceof WorkerTaskError ? "runtime_unavailable" : codeModeFailureCode(error),
    );
  } finally {
    if (!retained) {
      await closePool(pool);
    }
  }
}

export const nodeCodeModeExecutor: CodeModeExecutor = {
  id: "node",
  async execute(input, options) {
    const startedAt = performance.now();
    const deadline = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(
      () => deadline.abort(new CodeModeHeadlessTimeoutError()),
      Math.max(0, Math.min(input.config.timeoutMs, options.timeoutMs)),
    );
    const acquisition = takePool(input.config.memoryLimitBytes, signal);
    let pool: NodePool;
    try {
      pool = await racePromiseWithAbortSignal(acquisition, signal);
    } catch (error) {
      // The waiter can end before native retirement; a late pool must never execute its source.
      void runBestEffortCleanup({
        cleanup: () => acquisition.then(closePool, () => undefined),
        onError: (cleanupError) =>
          process.emitWarning(
            `Code Mode worker retirement failed: ${formatErrorMessage(cleanupError)}`,
          ),
      });
      if (signal.aborted) {
        const timeout = signal.reason instanceof CodeModeHeadlessTimeoutError;
        return failure(
          timeout ? "code mode timeout exceeded" : "code mode execution aborted",
          timeout ? "timeout" : "aborted",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return run(pool, input, options, startedAt);
  },
};
