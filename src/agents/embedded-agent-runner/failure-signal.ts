/**
 * Converts embedded run failures into provider failover signals.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isExecLikeToolName, type ToolErrorSummary } from "../tool-error-summary.js";
import type { EmbeddedRunFailureSignal } from "./types.js";

/**
 * Converts terminal tool errors from unattended embedded runs into failure signals.
 *
 * Cron runs need fatal execution-denied signals so schedulers do not treat blocked shell access as
 * a normal silent completion.
 */
const EXECUTION_DENIED_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;

type ExecutionDeniedCode = (typeof EXECUTION_DENIED_CODES)[number];

function resolveExecutionDeniedCode(value: string | undefined): ExecutionDeniedCode | undefined {
  for (const code of EXECUTION_DENIED_CODES) {
    if (value === code) {
      return code;
    }
  }
  return undefined;
}

/**
 * Report describing a single unknown-tool exhaustion event observed by the
 * runner's tool-call normalization guard. Cron uses this to fail closed
 * instead of delivering the injected self-debug text as a normal reply.
 */
export type UnknownToolLoopExhaustedReport = {
  toolName: string;
  rewriteCount?: number;
};

function buildUnknownToolExhaustedSignal(
  report: UnknownToolLoopExhaustedReport,
): EmbeddedRunFailureSignal {
  const toolName = normalizeOptionalString(report.toolName) ?? "unknown";
  const message = `Cron run aborted: model exhausted retries on unavailable tool "${toolName}".`;
  return {
    kind: "tool_unavailable_exhausted",
    source: "runner",
    toolName,
    code: "TOOL_UNAVAILABLE_EXHAUSTED",
    message,
    fatalForCron: true,
    bypassCronDelivery: true,
    ...(typeof report.rewriteCount === "number" && report.rewriteCount > 0
      ? { rewriteCount: report.rewriteCount }
      : {}),
  };
}

/**
 * Resolves fatal cron failure metadata from terminal embedded-run signals.
 *
 * The runner emits two kinds of fatal signals for cron:
 *   1. exec/bash tool errors with a structured host-denial code
 *      (`SYSTEM_RUN_DENIED`, `INVALID_REQUEST`) — non-recoverable in an
 *      unattended turn that cannot collect interactive approval.
 *   2. unknown-tool loop exhaustion — the model kept calling an
 *      unavailable tool until the runner's loop guard rewrote the final
 *      assistant message into canned self-debug text (#92535). Delivering
 *      that text via Telegram would leak the runner's internal repair
 *      string to the user, so cron must fail closed and surface the
 *      condition to operators instead.
 */
export function resolveEmbeddedRunFailureSignal(params: {
  trigger?: string | undefined;
  lastToolError?: ToolErrorSummary | undefined;
  unknownToolLoopExhausted?: UnknownToolLoopExhaustedReport | undefined;
}): EmbeddedRunFailureSignal | undefined {
  if (params.trigger !== "cron") {
    return undefined;
  }
  // Prefer the structured exec-denial classification when both signals are
  // present: a real host-denial is more diagnostic than the downstream
  // loop-guard rewrite that the model usually emits after the denial.
  const lastToolError = params.lastToolError;
  if (lastToolError && isExecLikeToolName(lastToolError.toolName)) {
    const code = resolveExecutionDeniedCode(normalizeOptionalString(lastToolError.errorCode));
    if (code) {
      const message = normalizeOptionalString(lastToolError.error) ?? code;
      return {
        kind: "execution_denied",
        source: "tool",
        ...(lastToolError.toolName ? { toolName: lastToolError.toolName } : {}),
        code,
        message,
        fatalForCron: true,
      };
    }
  }
  const exhausted = params.unknownToolLoopExhausted;
  if (exhausted && normalizeOptionalString(exhausted.toolName)) {
    return buildUnknownToolExhaustedSignal(exhausted);
  }
  return undefined;
}
