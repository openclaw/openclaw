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
type ExecutionDeniedFailureSignal = Extract<EmbeddedRunFailureSignal, { kind: "execution_denied" }>;

function resolveFailureSignalCode(
  value: string | undefined,
): ExecutionDeniedFailureSignal["code"] | undefined {
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
  unknownToolLoopIntervention?:
    | {
        toolName?: string;
        message?: string;
      }
    | undefined;
}): EmbeddedRunFailureSignal | undefined {
  if (params.trigger !== "cron") {
    return undefined;
  }
  const lastToolError = params.lastToolError;
  if (lastToolError && isExecLikeToolName(lastToolError.toolName)) {
    // A concrete exec denial wins when both signals exist; it names the tool
    // failure the runner observed, while guard metadata only describes a rewrite.
    const code = resolveFailureSignalCode(normalizeOptionalString(lastToolError.errorCode));
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
  const unavailableToolName = normalizeOptionalString(params.unknownToolLoopIntervention?.toolName);
  const unavailableToolMessage = normalizeOptionalString(
    params.unknownToolLoopIntervention?.message,
  );
  if (!unavailableToolName || !unavailableToolMessage) {
    return undefined;
  }
  return {
    kind: "unavailable_tool_repeat",
    source: "tool",
    toolName: unavailableToolName,
    code: "UNAVAILABLE_TOOL_REPEAT",
    message: unavailableToolMessage,
    fatalForCron: true,
  };
}
