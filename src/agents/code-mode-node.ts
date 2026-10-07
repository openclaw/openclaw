import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduledJob, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { runBestEffortCleanup } from "../infra/non-fatal-cleanup.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import {
  WorkerTaskError,
  WorkerTaskPool,
  type WorkerTaskResponse,
} from "../infra/worker-task-pool.js";
import {
  getBoundLegacyPluginSdkResourceHost,
  type LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
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
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerThreadResult,
} from "./code-mode-worker-types.js";

type NodePool = {
  tasks: WorkerTaskPool<NodeWorkerInput, CodeModeWorkerThreadResult<undefined>>;
  url: string;
  memoryLimitBytes: number;
  lifetime?: NodePoolLifetime;
};
type NodePoolLifetime = { scheduler: GatewaySchedulerScope; pools: Set<NodePool> };
type NodeInput = CodeModeExecutorStartInput | CodeModeExecutorResumeInput;
type NodeWorkerInput = NodeInput & { progress: SharedArrayBuffer; inlineHost: boolean };
const retiringPools = new Set<NodePool>();
const idlePools = new Map<NodePool, GatewayScheduledJob>();
const poolLifetimes = new WeakMap<LegacyPluginSdkResourceHost, NodePoolLifetime>();
let nextPoolId = 0;
const MAX_IDLE_POOLS = 4;
const memoryPressure = channel("openclaw.memory.critical");

function removeIdlePool(owner: NodePool): void {
  idlePools.get(owner)?.cancel();
  idlePools.delete(owner);
  if (!idlePools.size) {
    memoryPressure.unsubscribe(retireIdlePools);
  }
}

function retireIdlePool(owner: NodePool): void {
  if (!idlePools.has(owner)) {
    return;
  }
  void runBestEffortCleanup({
    cleanup: () => closePool(owner),
    onError: (error) =>
      process.emitWarning(`Code Mode worker retirement failed: ${formatErrorMessage(error)}`),
  });
}

function retireIdlePools(): void {
  // Suspended continuations also have idle task slots, but only completed cells are warm.
  for (const owner of idlePools.keys()) {
    retireIdlePool(owner);
  }
}

async function closePool(owner: NodePool): Promise<void> {
  removeIdlePool(owner);
  // Native slots retain custody until exit; keep their owner through pending or failed cleanup.
  retiringPools.add(owner);
  await owner.tasks.close();
  retiringPools.delete(owner);
  owner.lifetime?.pools.delete(owner);
}

function capturePoolLifetime(): NodePoolLifetime | undefined {
  const host = getBoundLegacyPluginSdkResourceHost();
  if (!host) {
    return undefined;
  }
  host.assertOpen();
  let lifetime = poolLifetimes.get(host);
  if (!lifetime) {
    const scheduler = host.scheduler.scope();
    const pools = new Set<NodePool>();
    lifetime = { scheduler, pools };
    host.adopt(lifetime, {
      release: async () => {
        scheduler.beginClose();
        const results = await Promise.allSettled([...pools].map(closePool));
        await scheduler.stop();
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new PluginRuntimeCloseRetainedError(
            new AggregateError(failures, "Code Mode workers failed to retire"),
          );
        }
      },
    });
    poolLifetimes.set(host, lifetime);
  }
  lifetime.scheduler.signal.throwIfAborted();
  return lifetime;
}

async function takePool(memoryLimitBytes: number, signal: AbortSignal): Promise<NodePool> {
  const lifetime = capturePoolLifetime();
  let workerUrl: URL;
  for (;;) {
    signal.throwIfAborted();
    lifetime?.scheduler.signal.throwIfAborted();
    workerUrl = resolveRuntimeProcessEntrypointUrl("codeModeNode");
    const retiring = new Set([
      ...[...retiringPools].filter(
        (owner) => owner.lifetime === lifetime || owner.lifetime?.scheduler.signal.aborted,
      ),
      ...[...idlePools.keys()].filter(
        (owner) =>
          owner.lifetime === lifetime && (owner.url !== workerUrl.href || owner.tasks.isClosed),
      ),
    ]);
    if (!retiring.size) {
      break;
    }
    await Promise.all([...retiring].map(closePool));
  }
  for (const owner of idlePools.keys()) {
    if (
      owner.memoryLimitBytes === memoryLimitBytes &&
      owner.lifetime === lifetime &&
      owner.url === workerUrl.href &&
      !owner.tasks.isClosed
    ) {
      removeIdlePool(owner);
      return owner;
    }
  }
  const owner: NodePool = {
    lifetime,
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
  lifetime?.pools.add(owner);
  return owner;
}

async function releasePool(owner: NodePool): Promise<void> {
  const { lifetime } = owner;
  if (
    idlePools.size >= MAX_IDLE_POOLS ||
    !lifetime ||
    lifetime.scheduler.signal.aborted ||
    owner.tasks.isClosed ||
    owner.url !== resolveRuntimeProcessEntrypointUrl("codeModeNode").href
  ) {
    await closePool(owner);
    return;
  }
  idlePools.set(
    owner,
    // Warm-worker retirement belongs to the host, never the completed turn's transcript context.
    runInDetachedAsyncContext(() =>
      lifetime.scheduler.schedule({
        id: `code-mode-worker-idle:${++nextPoolId}`,
        delayMs: 5 * 60_000,
        run: () => closePool(owner),
      }),
    ),
  );
  if (idlePools.size === 1) {
    memoryPressure.subscribe(retireIdlePools);
  }
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
  const progress = new CodeModeNodeProgress(input.config.maxOutputBytes);
  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let timer: NodeJS.Timeout | undefined;
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
        return {
          ...input,
          progress: progress.buffer,
          inlineHost: Boolean(inlineHost),
          config: { ...input.config, timeoutMs: admittedTimeoutMs },
        };
      },
      {
        timeoutMs: Math.min(options.timeoutMs, input.config.timeoutMs) - preparationMs,
        signal,
        inputBytes: input.kind === "exec" ? input.source.length * 2 : 0,
        onInputConsumed: () => {
          if (input.kind === "exec") {
            timer = setTimeout(
              () => deadline.abort(new CodeModeHeadlessTimeoutError()),
              Math.max(0, progress.deadline - performance.timeOrigin - performance.now()),
            );
          }
          inlineHost?.onInputConsumed?.();
        },
        onRequest: async (value, context): Promise<WorkerTaskResponse> => {
          clearTimeout(timer);
          if (!inlineHost || !isRecord(value) || value.status !== "boundary") {
            throw new Error("invalid code mode worker boundary");
          }
          if (!Number.isFinite(admittedTimeoutMs) || admittedTimeoutMs <= 0) {
            throw new Error("invalid code mode worker admission budget");
          }
          if (value.networkContentObserved === true) {
            inlineHost?.onNetworkContent?.();
          }
          const response = inlineHost.onBoundary(
            // SAFETY: The private Node worker emits the shared typed boundary protocol.
            value as CodeModeWorkerBoundary,
            { ...context, maxTimeoutMs: admittedTimeoutMs },
          );
          // Delivery is synchronous; the Worker is parked until this exchange gets its reply.
          progress.resetOutput();
          const { onConsumed, ...command } = await response;
          return {
            input: command,
            onConsumed,
            timeoutMs:
              command.kind === "continue" ? command.timeoutMs : CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
          };
        },
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
    const reason = signal.aborted ? signal.reason : error;
    if (
      reason instanceof CodeModeHeadlessTimeoutError ||
      (error instanceof WorkerTaskError && error.code === "timeout")
    ) {
      if (progress.networkContentObserved) {
        inlineHost?.onNetworkContent?.();
      }
      return {
        ...failure("code mode timeout exceeded", "timeout"),
        failurePhase: progress.deadline ? "guest" : "host",
        output: progress.output(),
        ...(progress.networkContentObserved ? { networkContentObserved: true } : {}),
      };
    }
    if (options.signal?.aborted || reason instanceof CodeModeHeadlessAbortError) {
      return failure("code mode execution aborted", "aborted");
    }
    return failure(
      error,
      error instanceof WorkerTaskError ? "runtime_unavailable" : codeModeFailureCode(error),
    );
  } finally {
    clearTimeout(timer);
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
