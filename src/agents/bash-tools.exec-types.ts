import type { NodePermissionRequest } from "../../packages/gateway-protocol/src/node-permissions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type {
  ExecApprovalDecision,
  ExecAsk,
  ExecHost,
  ExecMode,
  ExecSecurity,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer, ExecAutoReviewTranscript } from "../infra/exec-auto-review.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import type { TerminationReason } from "../process/supervisor/types.js";
import type { SecretStoreExecEnvironment } from "../secrets/store/secret-store.js";
import type { ToolApprovalReview } from "../shared/tool-approval-reviews.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import type { ExecToolRoutingDefaults } from "./bash-tools.exec-routing.types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import type { EmbeddedFullAccessBlockedReason } from "./embedded-agent-runner/types.js";
import type { ExecReviewerConfig } from "./exec-auto-reviewer.js";
import type { PreparedGitHubToolEnvironment } from "./github-tool-identity.types.js";

export type ExecToolDefaults = ExecToolRoutingDefaults & {
  hasCronTool?: boolean;
  mode?: ExecMode;
  bypassHostApprovalFloors?: boolean;
  trigger?: string;
  pathPrepend?: string[];
  safeBins?: string[];
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  safeBinTrustedDirs?: string[];
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  reviewer?: ExecReviewerConfig;
  config?: OpenClawConfig;
  /** Host-prepared non-secret environment and store projection exclusions. */
  preparedRunEnvironment?: PreparedGitHubToolEnvironment;
  /** An explicit snapshot, including an empty one, replaces local store access. */
  preparedStoreEnvironment?: Readonly<SecretStoreExecEnvironment>;
  /** Host-prepared routing hint; remote workers have no Gateway session database. */
  preparedSubagentExecution?: boolean;
  autoReviewer?: ExecAutoReviewer;
  /** Reads current attempt context only when a command needs review. */
  reviewTranscript?: () => ExecAutoReviewTranscript | undefined;
  agentId?: string;
  /** Credential owner when execution borrows another agent's tool policy. */
  executionAgentId?: string;
  backgroundMs?: number;
  cleanupMs?: number;
  timeoutSec?: number;
  approvalWarningText?: string;
  approvalFollowupText?: string;
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalFollowupMode?: "agent" | "direct";
  approvalRunningNoticeMs?: number;
  sandbox?: BashSandboxConfig;
  /** Immutable session policy that forbids execution outside its provisioned sandbox. */
  sandboxRequired?: boolean;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  /** Final run-local availability of the process continuation tool. */
  processToolAvailabilityRef?: { value?: boolean };
  scopeKey?: string;
  sessionKey?: string;
  /** Executing session when tool policy is borrowed from a different session. */
  runSessionKey?: string;
  /** Stable agent run that owns any approval created by this tool. */
  runId?: string;
  /** Exact admitted execution instance that owns secret-egress proxy access. */
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Durable session that receives detached exec completion events and approval followups. */
  notifySessionKey?: string;
  /** Ephemeral session UUID active when this exec tool was built. Regenerated
   *  on `/new` and `/reset`, so it pins exec-approval followups to the original
   *  session instance and lets stale followups drop after a session rebind. */
  sessionId?: string;
  /** `session.store` template from the runtime config. Lets the direct/denied
   *  exec approval followup path resolve the session key's current sessionId and
   *  drop the followup when the key was rebound by `/new` or `/reset`. */
  sessionStore?: string;
  /** @deprecated SDK declaration compatibility; coding-tool routing comes from config. */
  mainKey?: string;
  /** @deprecated SDK declaration compatibility; coding-tool routing comes from config. */
  sessionScope?: "per-sender" | "global";
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  /** Channel-owned sender/chat metadata. Exec subprocesses receive only sender/chat IDs. */
  channelContext?: PluginHookChannelContext;
  accountId?: string;
  approvalReviewerDeviceId?: string;
  /** Deny approval-requiring commands without creating operator approval events. */
  nonInteractiveApproval?: boolean;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  cwd?: string;
};

/** Request and approval context shared by Gateway and node execution hosts. */
export type ExecHostCommandParams = {
  command: string;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  security: ExecSecurity;
  ask: ExecAsk;
  bypassHostApprovalFloors?: boolean;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  signal?: AbortSignal;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  trigger?: string;
  agentId?: string;
  sessionKey?: string;
  toolCallId?: string;
  /** Session UUID active when the approval was requested; pins the followup. */
  sessionId?: string;
  /** Session-store template, so the direct/denied followup can detect a rebind. */
  sessionStore?: string;
  bashElevated?: ExecElevatedDefaults;
  approvalReviewerDeviceId?: string;
  nonInteractiveApproval?: boolean;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  approvalFollowupMode?: "agent" | "direct";
  warnings: string[];
  notifySessionKey?: string;
  approvalRunningNoticeMs: number;
  processContinuationAvailable?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
};

/** Outcome passed to approval follow-up factories after approved async exec. */
export type ExecApprovalFollowupOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitReason?: TerminationReason;
  timedOut: boolean;
  aggregated: string;
  reason?: string;
};

type ExecApprovalFollowupContext = {
  approvalId: string;
  sessionId: string;
  trigger?: string;
  outcome: ExecApprovalFollowupOutcome;
};

/** Hook that can append domain-specific text to approval follow-up messages. */
export type ExecApprovalFollowupFactory = (
  context: ExecApprovalFollowupContext,
) => string | undefined | Promise<string | undefined>;

/** Effective elevated-exec defaults derived from config/runtime policy. */
export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off" | "ask" | "full";
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
};

export function cloneExecElevatedDefaults(value: ExecElevatedDefaults): ExecElevatedDefaults {
  return {
    enabled: value.enabled,
    allowed: value.allowed,
    defaultLevel: value.defaultLevel,
    ...(value.fullAccessAvailable !== undefined
      ? { fullAccessAvailable: value.fullAccessAvailable }
      : {}),
    ...(value.fullAccessBlockedReason !== undefined
      ? { fullAccessBlockedReason: value.fullAccessBlockedReason }
      : {}),
  };
}

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
      followUp?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      exitSignal?: NodeJS.Signals | number | null;
      failureKind?: string;
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
