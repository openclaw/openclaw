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
const FAILURE_SIGNAL_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;

function resolveFailureSignalCode(
  value: string | undefined,
): EmbeddedRunFailureSignal["code"] | undefined {
  for (const code of FAILURE_SIGNAL_CODES) {
    if (value === code) {
      return code;
    }
  }
  return undefined;
}

/** Resolves fatal cron failure metadata from the last exec-like tool error, if applicable. */
export function resolveEmbeddedRunFailureSignal(params: {
  trigger?: string | undefined;
  lastToolError?: ToolErrorSummary | undefined;
}): EmbeddedRunFailureSignal | undefined {
  if (params.trigger !== "cron") {
    return undefined;
  }
  const lastToolError = params.lastToolError;
  if (!lastToolError || !isExecLikeToolName(lastToolError.toolName)) {
    return undefined;
  }
  const code = resolveFailureSignalCode(normalizeOptionalString(lastToolError.errorCode));
  if (!code) {
    return undefined;
  }
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

/**
 * Detects a ===DONE_ERR=== terminal failure sentinel in the final agent-visible text and
 * returns a structured failure signal. Only the last non-empty line is checked so mid-text
 * occurrences (followed by recovery) are ignored.
 * Cron-only: non-cron triggers are ignored so user-initiated runs are not affected.
 */
const DONE_ERR_SENTINEL = "===DONE_ERR===";

export function resolveEmbeddedRunSentinelSignal(params: {
  trigger?: string | undefined;
  finalAssistantVisibleText?: string | undefined;
}): EmbeddedRunFailureSignal | undefined {
  if (params.trigger !== "cron") {
    return undefined;
  }
  const normalizedText = normalizeOptionalString(params.finalAssistantVisibleText);
  if (!normalizedText) {
    return undefined;
  }
  const lastLine = normalizedText.trim().split("\n").at(-1)?.trim();
  if (lastLine?.startsWith(DONE_ERR_SENTINEL) === true) {
    return {
      kind: "done_err_sentinel",
      source: "agent_text",
      message: lastLine,
      fatalForCron: true,
    };
  }
  return undefined;
}
