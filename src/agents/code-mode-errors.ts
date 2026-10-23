import { formatErrorMessage } from "../infra/errors.js";
import type { CodeModeFailureCode } from "./code-mode-executor-types.js";
import { ToolInputError } from "./tool-input-error.js";

function isRuntimeInterruptedError(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === "interrupted";
}

export function codeModeFailureCode(error: unknown): CodeModeFailureCode {
  if (isRuntimeInterruptedError(error)) {
    return "timeout";
  }
  return error instanceof ToolInputError ? "invalid_input" : "internal_error";
}

export function codeModeFailureMessage(error: unknown): string {
  return isRuntimeInterruptedError(error)
    ? "code mode timeout exceeded"
    : formatErrorMessage(error);
}

export function normalizeCodeModeTimeoutResult<
  T extends { status: string; code?: unknown; error?: unknown },
>(result: T): T {
  return result.status === "failed" &&
    result.code === "timeout" &&
    !String(result.error).includes("timeout exceeded")
    ? { ...result, error: "code mode timeout exceeded" }
    : result;
}

export class CodeModeHeadlessAbortError extends Error {
  constructor(message = "code mode execution aborted") {
    super(message);
    this.name = "CodeModeHeadlessAbortError";
  }
}

export class CodeModeHeadlessTimeoutError extends Error {
  constructor(message = "code mode headless wall-clock timeout exceeded") {
    super(message);
    this.name = "CodeModeHeadlessTimeoutError";
  }
}
