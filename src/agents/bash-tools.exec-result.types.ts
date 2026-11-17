import type { NodePermissionRequest } from "../../packages/gateway-protocol/src/node-permissions.js";
import type { ExecApprovalDecision, ExecHost } from "../infra/exec-approvals.js";
import type { TerminationReason } from "../process/supervisor/types.js";
import type { ToolApprovalReview } from "../shared/tool-approval-reviews.js";

/** Outcome passed to approval follow-up factories after approved async exec. */
export type ExecApprovalFollowupOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitReason?: TerminationReason;
  timedOut: boolean;
  aggregated: string;
  reason?: string;
};

/** One model-backed approval review recorded on an exec tool call. */
export type ExecToolApprovalReview = Omit<ToolApprovalReview, "userAuthorization">;

/** Structured details returned by exec tool calls. */
export type ExecToolDetails = {
  permissionMissing?: NodePermissionRequest;
  approvalReviews?: readonly ExecToolApprovalReview[];
  approvalReviewOutcome?: "approved" | "denied" | "reviewing";
} & (
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      deadlineAtMs?: number;
      cwd?: string;
      tail?: string;
      warningText?: string;
      followUp?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      exitSignal?: NodeJS.Signals | number | null;
      failureKind?: string;
      message?: string;
      reason?: "not-dispatched" | "outcome-unknown" | "policy-denied" | "permission-missing";
      nodeInvokeFailure?: {
        failureCode?: string;
        message: string;
        nodeCommandDispatched?: boolean;
        requestSent?: boolean;
      };
      exitReason?: TerminationReason;
      durationMs: number;
      aggregated: string;
      timedOut?: boolean;
      noOutputTimedOut?: boolean;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    }
  | {
      status: "approval-pending";
      approvalId: string;
      approvalSlug: string;
      expiresAtMs: number;
      allowedDecisions?: readonly ExecApprovalDecision[];
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    }
  | {
      status: "approval-unavailable";
      reason:
        | "initiating-platform-disabled"
        | "initiating-platform-unsupported"
        | "no-approval-route";
      channel?: string;
      channelLabel?: string;
      accountId?: string;
      sentApproverDms?: boolean;
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    }
);
