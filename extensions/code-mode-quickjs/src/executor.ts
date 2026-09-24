import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  EMPTY_CODE_MODE_OUTPUT,
  type CodeModeExecutor,
  type CodeModeExecutorContinuation,
  type CodeModeExecutorRunOptions,
  type CodeModeFailureCode,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerPayload,
  type CodeModeWorkerResult,
  type CodeModeWorkerThreadResult,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveRuntimeWorkerUrl,
  WorkerTaskError,
  WorkerTaskPool,
  type WorkerTaskResponse,
} from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Snapshot } from "quickjs-wasi";

const getQuickJsModules = createLazyRuntimeModule(async () => {
  const resolve = createRequire(import.meta.url).resolve;
  const sourceExecution = /\.[cm]?ts$/u.test(new URL(import.meta.url).pathname);
  const compile = async (asset: string, sourceSpecifier: string) => {
    // Packaged JavaScript includes the engine; its WASM assets belong to the plugin.
    const binary = sourceExecution
      ? resolve(sourceSpecifier)
      : new URL(`../assets/${asset}`, codeModeWorkerUrl());
    return WebAssembly.compile(await readFile(binary));
  };
  const [wasmModule, encoding] = await Promise.all([
    compile("quickjs.wasm", "quickjs-wasi/quickjs.wasm"),
    compile("encoding.so", "quickjs-wasi/encoding.so"),
  ]);
  return {
    wasmModule,
    wasmExtensions: [{ name: "encoding", wasm: encoding }],
  };
});

type QuickJsWorkerPayload = CodeModeWorkerPayload<Snapshot> &
  Awaited<ReturnType<typeof getQuickJsModules>>;
type QuickJsWorkerPool = WorkerTaskPool<QuickJsWorkerPayload, CodeModeWorkerThreadResult<Snapshot>>;

let sharedPool: { url: string; pool: QuickJsWorkerPool } | undefined;

function codeModeWorkerUrl(): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "code-mode.worker",
    distWorkerPath: "extensions/code-mode-quickjs/src/code-mode.worker.js",
    package: { name: "@openclaw/code-mode-quickjs", distWorkerPath: "src/code-mode.worker.js" },
  });
}

function getCodeModePool(): QuickJsWorkerPool {
  const workerUrl = codeModeWorkerUrl();
  if (sharedPool?.url !== workerUrl.href) {
    void sharedPool?.pool.close();
    sharedPool = {
      url: workerUrl.href,
      pool: new WorkerTaskPool<QuickJsWorkerPayload, CodeModeWorkerThreadResult<Snapshot>>({
        workerUrl,
        sharedCompute: true,
      }),
    };
  }
  return sharedPool.pool;
}

function failedResult(
  error: unknown,
  code: CodeModeFailureCode,
): Extract<CodeModeWorkerResult, { status: "failed" }> {
  return {
    status: "failed",
    error: formatErrorMessage(error),
    code,
    failurePhase: "host",
    bridgeDispatchStarted: false,
    output: EMPTY_CODE_MODE_OUTPUT,
  };
}

function retainSnapshot(snapshot: Snapshot): CodeModeExecutorContinuation {
  let owned: Snapshot | undefined = snapshot;
  return {
    executor: "quickjs",
    retainedBytes: snapshot.memory.byteLength,
    async resume(input, options) {
      if (!owned) {
        return failedResult(
          "Code Mode continuation has already been consumed or disposed",
          "runtime_unavailable",
        );
      }
      const continuation = owned;
      owned = undefined;
      return runQuickJsWorker({ ...input, continuation }, options);
    },
    async dispose() {
      owned = undefined;
    },
  };
}

async function runQuickJsWorker(
  workerData: CodeModeWorkerPayload<Snapshot>,
  { timeoutMs, signal, inlineHost }: CodeModeExecutorRunOptions,
): Promise<CodeModeWorkerResult> {
  const startedAt = performance.now();
  let admittedTimeoutMs: number | undefined;
  try {
    const message = await getCodeModePool().run(
      async () => {
        const modules = await getQuickJsModules();
        // Queueing and initialization consume the same budget as guest execution.
        admittedTimeoutMs = Math.max(
          0,
          workerData.config.timeoutMs - (performance.now() - startedAt),
        );
        return {
          ...workerData,
          ...modules,
          config: { ...workerData.config, timeoutMs: admittedTimeoutMs },
        };
      },
      {
        timeoutMs,
        signal,
        inputBytes:
          workerData.kind === "resume"
            ? workerData.continuation.memory.byteLength
            : workerData.source.length * 2,
        onInputConsumed: inlineHost?.onInputConsumed,
        onRequest: inlineHost
          ? async (value, context): Promise<WorkerTaskResponse> => {
              if (!isRecord(value) || value.status !== "boundary") {
                throw new Error("invalid code mode worker boundary");
              }
              if (
                admittedTimeoutMs === undefined ||
                !Number.isFinite(admittedTimeoutMs) ||
                admittedTimeoutMs <= 0
              ) {
                throw new Error("invalid code mode worker admission budget");
              }
              if (value.networkContentObserved === true) {
                inlineHost.onNetworkContent?.();
              }
              const { onConsumed, ...input } = await inlineHost.onBoundary(
                // SAFETY: serveWorkerTasks sends the plugin's typed boundary; guest code cannot post host messages.
                value as CodeModeWorkerBoundary,
                { ...context, maxTimeoutMs: admittedTimeoutMs },
              );
              return {
                input,
                onConsumed,
                timeoutMs:
                  (input.kind === "continue" ? input.timeoutMs : 0) +
                  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
              };
            }
          : undefined,
        transferList: (input) => {
          if (input.kind !== "resume") {
            return [];
          }
          // SAFETY: QuickJS.snapshot copies WASM memory with Uint8Array.slice into a dedicated ArrayBuffer.
          const memory = input.continuation.memory.buffer as ArrayBuffer;
          return [memory];
        },
      },
    );
    if (!isRecord(message)) {
      return failedResult("invalid code mode worker response", "internal_error");
    }
    if (message.networkContentObserved === true) {
      inlineHost?.onNetworkContent?.();
    }
    const result = message;
    return result.status === "waiting"
      ? { ...result, continuation: retainSnapshot(result.continuation) }
      : result;
  } catch (error) {
    if (signal?.aborted) {
      return failedResult(
        signal.reason instanceof CodeModeHeadlessTimeoutError
          ? "code mode timeout exceeded"
          : "code mode execution aborted",
        signal.reason instanceof CodeModeHeadlessTimeoutError ? "timeout" : "aborted",
      );
    }
    if (error instanceof CodeModeHeadlessTimeoutError) {
      return failedResult("code mode timeout exceeded", "timeout");
    }
    if (error instanceof CodeModeHeadlessAbortError) {
      return failedResult("code mode execution aborted", "aborted");
    }
    return error instanceof WorkerTaskError && error.code === "timeout"
      ? failedResult("code mode worker timeout exceeded", "timeout")
      : failedResult(error, "runtime_unavailable");
  }
}

export const codeModeExecutor: CodeModeExecutor = {
  id: "quickjs",
  execute: runQuickJsWorker,
};
