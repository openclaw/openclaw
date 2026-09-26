import type { ExecHost } from "../infra/exec-approvals.js";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { invalidateTaskActivity } from "../tasks/task-registry-activity.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { getActiveBackgroundExecSession } from "./bash-process-registry.js";
import { EXEC_RETENTION_CAP_NOTE, renderExecOutputText } from "./bash-tools.exec-output.js";
import type { ExecToolArgs } from "./bash-tools.exec-request-preparation.js";
import { resolveExecTarget, type ExecProcessHandle } from "./bash-tools.exec-runtime.js";
import {
  type BackgroundExecTaskHandle,
  createBackgroundExecTask,
  finalizeBackgroundExecTask,
} from "./bash-tools.exec-task-tracking.js";
import type {
  ExecProcessOutcome,
  ExecToolApprovalReview,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { failedTextResult, textResult } from "./tools/common.js";
import { withoutGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

export function createExecProcessSettlement() {
  let registration: Promise<void> | undefined;
  let lastActivityAt: number | undefined;
  let backgroundTask: BackgroundExecTaskHandle | null = null;
  const settlement: {
    outcome: ExecProcessOutcome | null;
    register: (
      run: ExecProcessHandle,
      sessionKey: string | undefined,
      agentId: string | undefined,
    ) => void | Promise<void>;
    settle: (outcome: ExecProcessOutcome) => void | Promise<void>;
    activity: (at: number) => void;
  } = {
    outcome: null,
    register(run, sessionKey, agentId) {
      return withoutGatewayToolCallerIdentity(() => {
        const created = createBackgroundExecTask({
          processSessionId: run.session.id,
          command: run.session.command,
          sessionKey,
          agentId,
          startedAt: run.startedAt,
          assertCurrent() {
            if (getActiveBackgroundExecSession(run.session.id) !== run.session) {
              throw new Error("Background exec process owner is no longer active");
            }
          },
        });
        const accept = (task: BackgroundExecTaskHandle | null) => {
          backgroundTask = task;
          if (task && lastActivityAt !== undefined && !settlement.outcome) {
            invalidateTaskActivity(task.taskId, lastActivityAt);
          }
        };
        if (created instanceof Promise) {
          registration = created.then(accept);
          return registration;
        }
        return accept(created);
      });
    },
    activity(at) {
      lastActivityAt = at;
      if (backgroundTask && !settlement.outcome) {
        invalidateTaskActivity(backgroundTask.taskId, at);
      }
    },
    settle(outcome: ExecProcessOutcome) {
      settlement.outcome = outcome;
      const finalize = () => finalizeBackgroundExecTask({ handle: backgroundTask, outcome });
      return registration ? registration.then(finalize) : finalize();
    },
  };
  return settlement;
}

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
  aggregateOutputDropped?: boolean;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  const retentionCapNote = params.aggregateOutputDropped ? EXEC_RETENTION_CAP_NOTE : "";
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
    return failedTextResult(outputText, {
      status: "failed",
      exitCode: params.outcome.exitCode ?? null,
      exitSignal: params.outcome.exitSignal,
      failureKind: params.outcome.failureKind,
      exitReason: params.outcome.exitReason,
      durationMs: params.outcome.durationMs,
      aggregated: params.outcome.aggregated,
      timedOut: params.outcome.timedOut,
      noOutputTimedOut: params.outcome.noOutputTimedOut,
      cwd: params.cwd,
    });
  }
  const outputText = `${retentionCapNote}${warningText}${renderExecOutputText(params.outcome.aggregated)}`;
  return textResult(outputText, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    exitSignal: params.outcome.exitSignal,
    exitReason: params.outcome.exitReason,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
    noOutputTimedOut: params.outcome.noOutputTimedOut,
    cwd: params.cwd,
  });
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

// Preparation and execution must interpret elevation identically before host policy runs.
export function resolveExecElevatedMode(
  defaults: ExecToolDefaults | undefined,
  requested: unknown,
) {
  const elevated = defaults?.elevated;
  const defaultMode =
    elevated?.defaultLevel === "full"
      ? "full"
      : elevated?.defaultLevel === "ask" || elevated?.defaultLevel === "on"
        ? "ask"
        : "off";
  if (typeof requested === "boolean") {
    return requested ? (defaultMode === "full" ? "full" : "ask") : "off";
  }
  return elevated?.enabled && elevated.allowed && !defaults?.sandboxRequired ? defaultMode : "off";
}

export function createExecHostResolver(defaults?: ExecToolDefaults) {
  return (params: ExecToolArgs): ExecHost => {
    const elevatedMode = resolveExecElevatedMode(defaults, params.elevated);
    const requestedTarget = requireValidExecTarget(params.host);
    return resolveExecTarget({
      configuredTarget: defaults?.host,
      requestedTarget,
      elevatedRequested: elevatedMode !== "off",
      sandboxAvailable: Boolean(defaults?.sandbox),
      sandboxRequired: defaults?.sandboxRequired,
    }).effectiveHost;
  };
}
