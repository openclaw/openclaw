import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  annotateRuntimeExecutionError,
  noteRuntimeDynamicExecution,
} from "../infra/runtime-profile.js";
import {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  normalizeCodeModeTimeoutResult,
} from "./code-mode-errors.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeExecutorId,
  CodeModeExecutorRunOptions,
  CodeModeWorkerResult,
} from "./code-mode-executor-types.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import type { CodeModeWorkerPayload } from "./code-mode-worker-types.js";

function normalizeCodeModeRuntimeResult(result: CodeModeWorkerResult): CodeModeWorkerResult {
  const normalized = normalizeCodeModeTimeoutResult(result);
  return normalized.status === "failed"
    ? {
        ...normalized,
        error: formatErrorMessage(annotateRuntimeExecutionError(normalized.error, "Code Mode")),
      }
    : normalized;
}

export async function runCodeModeExecutor(
  input: CodeModeWorkerPayload<CodeModeExecutorContinuation>,
  options: CodeModeExecutorRunOptions & {
    executor: CodeModeExecutorId;
    runtimeConfig?: OpenClawConfig;
  },
): Promise<CodeModeWorkerResult> {
  const startedAt = performance.now();
  const executionOptions: CodeModeExecutorRunOptions = {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    inlineHost: options.inlineHost,
  };
  try {
    options.signal?.throwIfAborted();
    const executorId = input.kind === "resume" ? input.continuation.executor : options.executor;
    if (executorId === "node") {
      noteRuntimeDynamicExecution("code-mode");
    }
    if (input.kind === "resume") {
      const { continuation, ...resumeInput } = input;
      return normalizeCodeModeRuntimeResult(
        await continuation.resume(resumeInput, executionOptions),
      );
    }
    const executor =
      options.executor === "node"
        ? (await import("./code-mode-node.js")).nodeCodeModeExecutor
        : (await import("../plugins/code-mode-executor.js")).resolvePluginCodeModeExecutor(
            options.executor,
            options.runtimeConfig,
          );
    options.signal?.throwIfAborted();
    const preparationMs = performance.now() - startedAt;
    const timeoutMs = input.config.timeoutMs - preparationMs;
    if (timeoutMs <= 0 || executionOptions.timeoutMs <= preparationMs) {
      throw new CodeModeHeadlessTimeoutError();
    }
    return normalizeCodeModeRuntimeResult(
      await executor.execute(
        { ...input, config: { ...input.config, timeoutMs } },
        { ...executionOptions, timeoutMs: executionOptions.timeoutMs - preparationMs },
      ),
    );
  } catch (error) {
    options.inlineHost?.onFailure?.(error, "host");
    if (input.kind === "resume") {
      await input.continuation.dispose();
    }
    const reason = options.signal?.aborted ? options.signal.reason : error;
    const timeout = reason instanceof CodeModeHeadlessTimeoutError;
    const aborted = options.signal?.aborted || reason instanceof CodeModeHeadlessAbortError;
    return {
      status: "failed",
      code: timeout ? "timeout" : aborted ? "aborted" : "runtime_unavailable",
      error: timeout
        ? "code mode timeout exceeded"
        : aborted
          ? "code mode execution aborted"
          : formatErrorMessage(annotateRuntimeExecutionError(error, "Code Mode")),
      failurePhase: "host",
      bridgeDispatchStarted: false,
      output: EMPTY_CODE_MODE_OUTPUT,
    };
  }
}
