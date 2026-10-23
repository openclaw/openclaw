import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import {
  canRecoverExecOutput,
  execOutputLogDetails,
  execOutputLogNote,
  type ExecOutputLog,
} from "./bash-tools.exec-output-log.js";
import { EXEC_RETENTION_CAP_NOTE, renderExecOutputText } from "./bash-tools.exec-output.js";
import type {
  ExecProcessOutcome,
  ExecToolApprovalReview,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { failedTextResult, textResult } from "./tools/common.js";

export function attachExecApprovalReview(
  result: AgentToolResult<ExecToolDetails>,
  review?: ExecToolApprovalReview,
): AgentToolResult<ExecToolDetails> {
  if (review) {
    result.details.approvalReviews = [review];
    result.details.approvalReviewOutcome = review.status === "approved" ? "approved" : "denied";
  }
  return result;
}

export function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
  discardedOutputChars?: number;
  outputLog?: ExecOutputLog;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  const discardedChars = params.discardedOutputChars ?? 0;
  const retentionCapNote =
    discardedChars > 0 && !canRecoverExecOutput(params.outputLog, discardedChars)
      ? EXEC_RETENTION_CAP_NOTE
      : "";
  const outputLogNote = execOutputLogNote(params.outputLog);
  const outcome = params.outcome;
  const details: ExecToolDetails = {
    ...execOutputLogDetails(params.outputLog),
    status: outcome.status,
    exitCode: outcome.status === "failed" ? (outcome.exitCode ?? null) : outcome.exitCode,
    exitSignal: outcome.exitSignal,
    ...(outcome.status === "failed" ? { failureKind: outcome.failureKind } : {}),
    exitReason: outcome.exitReason,
    durationMs: outcome.durationMs,
    aggregated: outcome.aggregated,
    ...(outcome.status === "failed" ? { timedOut: outcome.timedOut } : {}),
    noOutputTimedOut: outcome.noOutputTimedOut,
    cwd: params.cwd,
  };
  if (params.outcome.status === "failed") {
    const linuxOomGuidance =
      params.outcome.failureKind === "signal" &&
      params.outcome.exitReason === "signal" &&
      params.outcome.oomScoreWrapperSelected === true &&
      (params.outcome.exitSignal === "SIGKILL" || params.outcome.exitSignal === 9)
        ? "\n\nOpenClaw selected its Linux OOM-score wrapper, which attempts to set this child's oom_score_adj to 1000. " +
          "SIGKILL alone does not identify whether the Linux OOM killer, an operator, or another process sent it. " +
          "Check cgroup memory events or kernel logs. If they show memory pressure, narrow the command or adjust memory, concurrency, or resource limits."
        : "";
    const outputText = `${retentionCapNote}${outputLogNote}${warningText}${params.outcome.reason}${linuxOomGuidance}`;
    return failedTextResult(outputText, { ...details, status: "failed" });
  }
  const outputText = `${retentionCapNote}${outputLogNote}${warningText}${renderExecOutputText(params.outcome.aggregated)}`;
  return textResult(outputText, details);
}

export function resolveExecReviewerDefaults(params: {
  defaults?: ExecToolDefaults;
  agentId?: string;
}) {
  if (params.defaults?.reviewer) {
    return params.defaults.reviewer;
  }
  const cfg = params.defaults?.config;
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const agentExec = agentId && cfg ? resolveAgentConfig(cfg, agentId)?.tools?.exec : undefined;
  return agentExec?.reviewer ?? cfg?.tools?.exec?.reviewer;
}
