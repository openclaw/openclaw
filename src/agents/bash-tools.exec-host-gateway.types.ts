import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import type { SecretEgressSentinelBinding } from "../secrets/egress-proxy/proxy-server.js";
import type {
  ExecElevatedDefaults,
  ExecApprovalFollowupFactory,
  ExecToolApprovalReview,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Full input bundle for gateway-host allowlist and approval processing. */
export type ProcessGatewayAllowlistParams = {
  command: string;
  workdir: string;
  env: Record<string, string>;
  secretEgressBindings?: readonly SecretEgressSentinelBinding[];
  githubProfileDir?: string;
  pathPrepend?: string[];
  requestedEnv?: Record<string, string>;
  pty: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  security: ExecSecurity;
  ask: ExecAsk;
  bypassHostApprovalFloors?: boolean;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  signal?: AbortSignal;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  trigger?: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  onApprovalReview?: (review: ExecToolApprovalReview) => void;
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
  scopeKey?: string;
  approvalFollowupText?: string;
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalFollowupMode?: "agent" | "direct";
  warnings: string[];
  notifySessionKey?: string;
  approvalRunningNoticeMs: number;
  maxOutput: number;
  pendingMaxOutput: number;
  cleanupMs?: number;
  processContinuationAvailable?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
};

/** Gateway allowlist outcome before command execution continues. */
export type ProcessGatewayAllowlistResult = {
  execCommandOverride?: string;
  allowWithoutEnforcedCommand?: boolean;
  revalidateBeforeExecution?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
  assertCurrent?: () => void;
  pendingResult?: AgentToolResult<ExecToolDetails>;
  deniedResult?: AgentToolResult<ExecToolDetails>;
};
