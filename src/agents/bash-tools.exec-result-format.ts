import {
  prependRedactionWarning,
  redactExecDetails,
  redactExecOutputText,
  renderExecOutputText,
  withRedactionMarker,
} from "./bash-tools.exec-output.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { failedTextResult, textResult } from "./tools/common.js";

export function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
}): AgentToolResult<ExecToolDetails> {
  const originalWarningText = params.warningText?.trimEnd();
  const warning = originalWarningText?.trim()
    ? redactExecOutputText(originalWarningText).text.trimEnd()
    : "";
  const warningText = warning ? `${warning}\n\n` : "";
  const aggregatedResult = redactExecOutputText(params.outcome.aggregated);
  const aggregated = aggregatedResult.text;
  const warningRedacted = Boolean(originalWarningText?.trim()) && warning !== originalWarningText;
  if (params.outcome.status === "failed") {
    const reasonResult = redactExecOutputText(params.outcome.reason);
    const rawDetails = {
      status: "failed",
      exitCode: params.outcome.exitCode ?? null,
      exitSignal: params.outcome.exitSignal,
      failureKind: params.outcome.failureKind,
      exitReason: params.outcome.exitReason,
      durationMs: params.outcome.durationMs,
      aggregated,
      timedOut: params.outcome.timedOut,
      noOutputTimedOut: params.outcome.noOutputTimedOut,
      cwd: params.cwd,
    } satisfies ExecToolDetails;
    const details = redactExecDetails(rawDetails);
    const redacted =
      warningRedacted || aggregatedResult.redacted || reasonResult.redacted || details.redacted;
    return failedTextResult(
      prependRedactionWarning(`${warningText}${reasonResult.text}`, redacted),
      withRedactionMarker(details.details, redacted),
    );
  }
  const rawDetails = {
    status: "completed",
    exitCode: params.outcome.exitCode,
    exitSignal: params.outcome.exitSignal,
    exitReason: params.outcome.exitReason,
    durationMs: params.outcome.durationMs,
    aggregated,
    noOutputTimedOut: params.outcome.noOutputTimedOut,
    cwd: params.cwd,
  } satisfies ExecToolDetails;
  const details = redactExecDetails(rawDetails);
  const redacted = warningRedacted || aggregatedResult.redacted || details.redacted;
  return textResult(
    prependRedactionWarning(`${warningText}${renderExecOutputText(aggregated)}`, redacted),
    withRedactionMarker(details.details, redacted),
  );
}

export function buildExecRunningResult(params: {
  warningText?: string;
  sessionId: string;
  pid?: number;
  startedAt: number;
  cwd?: string;
  tail: string;
}): AgentToolResult<ExecToolDetails> {
  const originalWarningText = params.warningText?.trimEnd();
  const warning = originalWarningText?.trim()
    ? redactExecOutputText(originalWarningText).text.trimEnd()
    : "";
  const warningText = warning ? `${warning}\n\n` : "";
  const warningRedacted = Boolean(originalWarningText?.trim()) && warning !== originalWarningText;
  const tail = redactExecOutputText(params.tail);
  const rawDetails = {
    status: "running",
    sessionId: params.sessionId,
    pid: params.pid,
    startedAt: params.startedAt,
    cwd: params.cwd,
    tail: tail.text,
  } satisfies ExecToolDetails;
  const details = redactExecDetails(rawDetails);
  const redacted = warningRedacted || tail.redacted || details.redacted;
  return {
    content: [
      {
        type: "text",
        text: prependRedactionWarning(
          `${warningText}Command still running (session ${params.sessionId}, pid ${
            params.pid ?? "n/a"
          }). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.`,
          redacted,
        ),
      },
    ],
    details: withRedactionMarker(details.details, redacted),
  };
}
