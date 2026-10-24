import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduledJob, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { runBestEffortCleanup } from "../infra/non-fatal-cleanup.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import type { WorkerRetirementReason } from "../infra/worker-cpu.js";
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
import { codeModeNodeInitialization, prepareCodeModeNodeCatalog } from "./code-mode-node-input.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  type CodeModeNodeInput,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerThreadResult,
} from "./code-mode-worker-types.js";

type NodePool = {
  id: string;
  tasks: WorkerTaskPool<NodeWorkerInput, CodeModeWorkerThreadResult<undefined>>;
  url: string;
  memoryLimitBytes: number;
  lifetime?: NodePoolLifetime;
  draining?: true;
  onGcStorm: (workerId: unknown) => void;
};
type NodePoolLifetime = { scheduler: GatewaySchedulerScope; pools: Set<NodePool> };
type NodeInput = CodeModeExecutorStartInput | CodeModeExecutorResumeInput;
type NodeWorkerInput = CodeModeNodeInput;
function prepareInput(input: NodeInput) {
  if (input.kind === "resume") {
    return input;
  }
  const {
    [codeModeNodeInitialization]: initialization,
    catalog,
    namespaces,
    apiFiles,
    swarmEnabled,
    ...execution
  } = input;
  return {
    ...execution,
    initialization:
      initialization ??
      prepareCodeModeNodeCatalog({ catalog, namespaces, apiFiles, swarmEnabled })[
        codeModeNodeInitialization
      ],
  };
}
const retiringPools = new Set<NodePool>();
const idlePools = new Map<NodePool, GatewayScheduledJob[]>();
const poolLifetimes = new WeakMap<LegacyPluginSdkResourceHost, NodePoolLifetime>();
let nextPoolId = 0;
const MAX_IDLE_POOLS = 4;
const memoryPressure = channel("openclaw.memory.critical");
const gcStorm = channel("openclaw.code-mode.gc-storm");
let nextGcStormRetirementAt = 0;

function removeIdlePool(owner: NodePool): void {
  for (const job of idlePools.get(owner) ?? []) {
    job.cancel();
  }
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
    cleanup: () => closePool(owner, "memory_pressure"),
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

async function closePool(owner: NodePool, reason: WorkerRetirementReason): Promise<void> {
  removeIdlePool(owner);
  gcStorm.unsubscribe(owner.onGcStorm);
  // Native slots retain custody until exit; keep their owner through pending or failed cleanup.
  retiringPools.add(owner);
  await owner.tasks.close(undefined, owner.draining ? "gc-storm" : reason);
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
        const results = await Promise.allSettled(
          [...pools].map((owner) => closePool(owner, "shutdown")),
        );
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
    await Promise.all([...retiring].map((owner) => closePool(owner, "rotation")));
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
    id: `code-mode-node:${++nextPoolId}`,
    lifetime,
    url: workerUrl.href,
    memoryLimitBytes,
    onGcStorm(workerId) {
      if (workerId !== owner.id || owner.draining || performance.now() < nextGcStormRetirementAt) {
        return;
      }
      // Admit at most one draining worker per minute; later detector windows retry the rest.
      nextGcStormRetirementAt = performance.now() + 60_000;
      owner.draining = true;
      // Only the lifecycle owner knows whether an idle task slot holds a continuation.
      retireIdlePool(owner);
    },
    tasks: new WorkerTaskPool({
      workerUrl,
      workerClass: "singleton",
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
  gcStorm.subscribe(owner.onGcStorm);
  lifetime?.pools.add(owner);
  return owner;
}

async function releasePool(owner: NodePool): Promise<void> {
  const { lifetime } = owner;
  if (owner.draining) {
    await closePool(owner, "gc-storm");
    return;
  }
  if (!lifetime || lifetime.scheduler.signal.aborted || owner.tasks.isClosed) {
    await closePool(owner, lifetime?.scheduler.signal.aborted ? "shutdown" : "dispose");
    return;
  }
  if (owner.url !== resolveRuntimeProcessEntrypointUrl("codeModeNode").href) {
    await closePool(owner, "rotation");
    return;
  }
  if (idlePools.size >= MAX_IDLE_POOLS) {
    await closePool(owner, "eviction");
    return;
  }
  idlePools.set(
    owner,
    // Warm-worker retirement belongs to the host, never the completed turn's transcript context.
    runInDetachedAsyncContext(() => [
      lifetime.scheduler.schedule({
        id: `code-mode-worker-idle:${++nextPoolId}`,
        delayMs: 5 * 60_000,
        run: () => closePool(owner, "idle-expiry"),
      }),
      lifetime.scheduler.schedule({
        id: `code-mode-worker-surplus:${++nextPoolId}`,
        delayMs: 30_000,
        // Keep one warm isolate through gaps without retaining the completed burst.
        run: () =>
          idlePools.keys().next().value === owner ? undefined : closePool(owner, "idle-expiry"),
      }),
    ]),
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
      return (closing ??= closePool(pool, "dispose")
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
  inlineHost?.onWorkerAssigned?.(pool.id);
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
          ...prepareInput(input),
          progress: progress.buffer,
          inlineHost: Boolean(inlineHost),
          gcAttribution: { workerId: pool.id, ...inlineHost?.gcAttribution },
          config: { ...input.config, timeoutMs: admittedTimeoutMs },
        };
      },
      {
        timeoutMs: Math.min(options.timeoutMs, input.config.timeoutMs) - preparationMs,
        hostTimeout: "owner",
        signal,
        onNotification: (value) => {
          if (isRecord(value) && value.status === "failure") {
            inlineHost?.onFailure?.(
              value.error,
              value.failurePhase === "bridge" ||
                value.failurePhase === "guest" ||
                value.failurePhase === "input"
                ? value.failurePhase
                : "host",
              pool.id,
            );
          }
        },
        inputBytes: input.kind === "exec" ? input.source.length * 2 : 0,
        onInputConsumed: () => {
          if (input.kind === "exec" && progress.deadline > 0) {
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
    await releasePool(pool);
    retained = true;
    return result;
  } catch (error) {
    const reason = signal.aborted ? signal.reason : error;
    const timedOut =
      reason instanceof CodeModeHeadlessTimeoutError ||
      (error instanceof WorkerTaskError && error.code === "timeout");
    const failurePhase = timedOut && progress.deadline ? "guest" : "host";
    inlineHost?.onFailure?.(error, failurePhase, pool.id);
    if (timedOut) {
      if (progress.networkContentObserved) {
        inlineHost?.onNetworkContent?.();
      }
      return {
        ...failure("code mode timeout exceeded", "timeout"),
        failurePhase,
        output: progress.output(),
        ...(progress.networkContentObserved ? { networkContentObserved: true } : {}),
      };
    }
    if (options.signal?.aborted || reason instanceof CodeModeHeadlessAbortError) {
      return failure("code mode execution aborted", "aborted");
    }
    if (
      error instanceof WorkerTaskError &&
      isRecord(error.cause) &&
      (error.cause.code === "ERR_WORKER_OUT_OF_MEMORY" ||
        error.cause.code === "ERR_CODE_MODE_GC_THRASH")
    ) {
      if (progress.networkContentObserved) {
        inlineHost?.onNetworkContent?.();
      }
      return {
        ...failure(
          `${error.cause.code === "ERR_CODE_MODE_GC_THRASH" ? "Code Mode worker stopped after sustained garbage collection near its JavaScript heap limit" : `Code Mode worker exhausted its ${Math.floor(pool.memoryLimitBytes / (1024 * 1024))} MiB JavaScript heap`}. Paginate or narrow tool results and avoid retaining large arrays. Inspect any completed actions before retrying.`,
          "runtime_unavailable",
        ),
        output: progress.output(),
        ...(progress.networkContentObserved ? { networkContentObserved: true } : {}),
      };
    }
    return failure(
      error,
      error instanceof WorkerTaskError ? "runtime_unavailable" : codeModeFailureCode(error),
    );
  } finally {
    clearTimeout(timer);
    if (!retained) {
      await closePool(pool, "dispose");
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
        cleanup: () =>
          acquisition.then(
            (owner) => closePool(owner, "dispose"),
            () => undefined,
          ),
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
