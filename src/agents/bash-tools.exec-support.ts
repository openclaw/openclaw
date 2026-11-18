import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import {
  attachExecProgress,
  type ExecDroppedOutputFacts,
  type ExecProcessOutcome,
  renderExecDroppedOutputNote,
  renderExecOutputText,
} from "./bash-tools.exec-output.js";
import type { ExecToolApprovalReview, ExecToolDetails } from "./bash-tools.exec-result.types.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { textResult } from "./tools/tool-results.js";

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
  session?: ExecDroppedOutputFacts;
}): AgentToolResult<ExecToolDetails> {
  const warning = params.warningText?.trim();
  const warningText = warning ? `${params.warningText}\n\n` : "";
  const retentionCapNote = params.session ? renderExecDroppedOutputNote(params.session) : "";
  const file = params.session?.outputFile;
  const outcome = params.outcome;
  const details: ExecToolDetails = {
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
    ...(warning ? { warningText: warning } : {}),
    // Record-time truncation keeps this path visible when it cuts the result; a file cut at
    // its limit stays marked partial through history elision.
    ...(file
      ? { fullOutputPath: file.path, ...(file.limitReached ? { spillTruncated: true } : {}) }
      : {}),
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
    const outputText = `${retentionCapNote}${warningText}${params.outcome.reason}${linuxOomGuidance}`;
    const message = `${retentionCapNote}${warningText}${params.outcome.message}${linuxOomGuidance}`;
    return attachExecProgress(textResult(outputText, { ...details, status: "failed", message }));
  }
  const outputText = `${retentionCapNote}${warningText}${renderExecOutputText(params.outcome.aggregated)}`;
  return attachExecProgress(textResult(outputText, details));
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
