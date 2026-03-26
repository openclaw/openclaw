import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { SessionFailureReport, SessionVerifyReport } from "../config/sessions/types.js";

type RunError = {
  kind: "context_overflow" | "compaction_failure" | "role_ordering" | "image_size" | "retry_limit";
  message: string;
};

type ToolError = {
  toolName: string;
  meta?: string;
  error?: string;
};

function normalizeMessage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function classifyToolFailure(params: {
  generatedAt: number;
  toolError: ToolError;
}): SessionFailureReport {
  const toolName = params.toolError.toolName.trim();
  const message = normalizeMessage(params.toolError.error);
  const messageLower = message?.toLowerCase() ?? "";
  const isApprovalFailure =
    messageLower.includes("approval") ||
    messageLower.includes("allowlist") ||
    messageLower.includes("user-denied") ||
    messageLower.includes("permission denied");

  return {
    status: "failed",
    generatedAt: params.generatedAt,
    category: isApprovalFailure ? "approval" : "tool",
    source: "tool-result",
    code: isApprovalFailure ? "approval_error" : "tool_error",
    summary: isApprovalFailure
      ? `Tool ${toolName} hit an approval failure`
      : `Tool ${toolName} failed`,
    ...(message ? { message } : {}),
    toolName,
    ...(params.toolError.meta ? { toolMeta: params.toolError.meta } : {}),
  };
}

function classifyRunError(params: {
  generatedAt: number;
  runError: RunError;
}): SessionFailureReport {
  const runErrorKind = params.runError.kind;
  const code = runErrorKind;
  const category =
    runErrorKind === "context_overflow" || runErrorKind === "compaction_failure"
      ? "context"
      : runErrorKind === "retry_limit"
        ? "retry"
        : "model";
  return {
    status: "failed",
    generatedAt: params.generatedAt,
    category,
    source: "run-error",
    code,
    summary:
      runErrorKind === "context_overflow"
        ? "Run failed because the context overflowed"
        : runErrorKind === "compaction_failure"
          ? "Run failed because compaction recovery failed"
          : runErrorKind === "role_ordering"
            ? "Run failed because the model returned invalid role ordering"
            : runErrorKind === "image_size"
              ? "Run failed because an image exceeded model limits"
              : "Run failed because retry limit was reached",
    message: params.runError.message,
    runErrorKind,
  };
}

export function buildFailureReport(params: {
  generatedAt: number;
  aborted?: boolean;
  timedOut?: boolean;
  runError?: RunError;
  verifyReport?: SessionVerifyReport;
  lastToolError?: ToolError;
  lastAssistant?: AssistantMessage;
}): SessionFailureReport {
  if (params.aborted) {
    return {
      status: "failed",
      generatedAt: params.generatedAt,
      category: "aborted",
      source: "run-error",
      code: "aborted",
      summary: "Run was aborted",
    };
  }

  if (params.timedOut) {
    return {
      status: "failed",
      generatedAt: params.generatedAt,
      category: "timeout",
      source: "run-error",
      code: "timeout",
      summary: "Run timed out before completion",
    };
  }

  if (params.runError) {
    return classifyRunError({
      generatedAt: params.generatedAt,
      runError: params.runError,
    });
  }

  if (params.verifyReport?.status === "failed") {
    return {
      status: "failed",
      generatedAt: params.generatedAt,
      category: "verification",
      source: "verify-runner",
      code: "verify_failed",
      summary: `${params.verifyReport.checksFailed}/${params.verifyReport.checksRun} verification checks failed`,
      verifyChecksRun: params.verifyReport.checksRun,
      verifyChecksFailed: params.verifyReport.checksFailed,
    };
  }

  if (params.lastToolError) {
    return classifyToolFailure({
      generatedAt: params.generatedAt,
      toolError: params.lastToolError,
    });
  }

  if (params.lastAssistant?.stopReason === "error") {
    return {
      status: "failed",
      generatedAt: params.generatedAt,
      category: "model",
      source: "assistant-error",
      code: "assistant_error",
      summary: "Assistant returned an error response",
      ...(normalizeMessage(params.lastAssistant.errorMessage)
        ? { message: normalizeMessage(params.lastAssistant.errorMessage) }
        : {}),
    };
  }

  return {
    status: "none",
    generatedAt: params.generatedAt,
    category: "none",
    source: "none",
    code: "none",
    summary: "No structured failure detected",
  };
}
