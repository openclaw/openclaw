import type { SystemRunExecutionContext } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";

export type ExecuteNodeHostCommandParams = {
  command: string;
  toolCallId?: string;
  workdir: string | undefined;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  executionContext?: SystemRunExecutionContext;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  /** Session UUID active when the approval was requested; pins the followup. */
  sessionId?: string;
  /** Session-store template, so the direct/denied followup can detect a rebind. */
  sessionStore?: string;
  bashElevated?: ExecElevatedDefaults;
  approvalReviewerDeviceId?: string;
  nonInteractiveApproval?: boolean;
  approvalFollowupMode?: "agent" | "direct";
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  trigger?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  bypassHostApprovalFloors?: boolean;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  signal?: AbortSignal;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  /** Warnings that apply only when the command runs inline, never while approval is pending. */
  foregroundWarnings?: string[];
  processContinuationAvailable?: boolean;
  notifySessionKey?: string;
  notifyOnExit?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
};
