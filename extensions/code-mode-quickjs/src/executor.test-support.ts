import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type {
  CodeModeConfig,
  CodeModeExecutorContinuation,
  CodeModeExecutorInlineHost,
  CodeModeExecutorStartInput,
  CodeModeWorkerPayload,
  CodeModeWorkerThreadResult,
  CodeModeWorkerResult,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { Snapshot } from "quickjs-wasi";
import { onTestFinished, vi } from "vitest";
import { codeModeExecutor } from "./executor.js";

export function createQuickJsTestConfig(overrides: Partial<CodeModeConfig> = {}): CodeModeConfig {
  return {
    timeoutMs: 10_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputBytes: 64 * 1024,
    maxPendingToolCalls: 16,
    maxSnapshotBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

type StartInput = Omit<CodeModeExecutorStartInput, "namespaces"> &
  Partial<Pick<CodeModeExecutorStartInput, "namespaces">>;
type Input =
  | StartInput
  | Extract<CodeModeWorkerPayload<CodeModeExecutorContinuation>, { kind: "resume" }>;

export async function runQuickJsExecutor(
  input: Input,
  timeoutMs: number,
  workerUrl?: URL,
  signal?: AbortSignal,
  inlineHost?: CodeModeExecutorInlineHost,
) {
  const resolver = workerUrl
    ? vi.spyOn(processRuntime, "resolveRuntimeWorkerUrl").mockReturnValue(workerUrl)
    : undefined;
  try {
    const options = { timeoutMs, signal, inlineHost };
    let result: CodeModeWorkerResult;
    if (input.kind === "exec") {
      result = await codeModeExecutor.execute(
        { ...input, namespaces: input.namespaces ?? [] },
        options,
      );
    } else {
      const { continuation, ...resume } = input;
      result = await continuation.resume(resume, options);
    }
    if (result.status === "waiting") {
      onTestFinished(() => result.continuation.dispose());
    }
    return result;
  } finally {
    resolver?.mockRestore();
  }
}

const resolve = createRequire(import.meta.url).resolve;
const modules = Promise.all([
  readFile(resolve("quickjs-wasi/quickjs.wasm")).then((bytes) => WebAssembly.compile(bytes)),
  readFile(resolve("quickjs-wasi/encoding.so")).then((bytes) => WebAssembly.compile(bytes)),
]).then(([wasmModule, encoding]) => ({
  wasmModule,
  wasmExtensions: [{ name: "encoding", wasm: encoding }],
}));

/** Exercises real persisted VM bytes without exposing them through the executor contract. */
export async function runQuickJsWire(input: CodeModeWorkerPayload<Snapshot>, timeoutMs: number) {
  const pool = new processRuntime.WorkerTaskPool<unknown, CodeModeWorkerThreadResult<Snapshot>>({
    workerUrl: new URL("./code-mode.worker.ts", import.meta.url),
    maxWorkers: 1,
  });
  try {
    return await pool.run({ ...input, ...(await modules) }, { timeoutMs });
  } finally {
    await pool.close();
  }
}
