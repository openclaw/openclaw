import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import type { SpawnInitiation } from "../process/spawn-initiation.js";
import type { SecretEgressSentinelBinding } from "../secrets/egress-proxy/proxy-server.js";
import type {
  ExecHostCommandParams,
  ExecApprovalFollowupFactory,
  ExecToolApprovalReview,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Full input bundle for gateway-host allowlist and approval processing. */
export type ProcessGatewayAllowlistParams = ExecHostCommandParams & {
  workdir: string;
  secretEgressBindings?: readonly SecretEgressSentinelBinding[];
  githubProfileDir?: string;
  pathPrepend?: string[];
  pty: boolean;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  runId?: string;
  onApprovalReview?: (review: ExecToolApprovalReview) => void;
  scopeKey?: string;
  approvalFollowupText?: string;
  approvalFollowup?: ExecApprovalFollowupFactory;
  maxOutput: number;
  pendingMaxOutput: number;
  cleanupMs?: number;
};

/** Gateway allowlist outcome before command execution continues. */
export type ProcessGatewayAllowlistResult = {
  execCommandOverride?: string;
  allowWithoutEnforcedCommand?: boolean;
  revalidateBeforeExecution?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
  assertCurrent?: () => void;
  initiateSpawn?: SpawnInitiation;
  releaseSpawn?: (reason?: "retry") => void;
  pendingResult?: AgentToolResult<ExecToolDetails>;
  deniedResult?: AgentToolResult<ExecToolDetails>;
};
