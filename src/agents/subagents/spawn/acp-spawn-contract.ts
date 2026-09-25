import type { AcpTurnAttachment } from "../../../acp/control-plane/manager.types.js";
import type { InheritedToolPolicyV2 } from "../../inherited-tool-policy.schema.js";
import type { SpawnAcpMode } from "./acp-spawn-result.js";

export type SpawnAcpSandboxMode = "inherit" | "require";

export type SpawnAcpParams = {
  task: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  streamTo?: "parent";
  attachments?: AcpTurnAttachment[];
};

export type SpawnAcpContext = {
  onSpawnEffectsStart?: () => void;
  assertActive?: () => void;
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  completionOwnerKey?: string;
  requesterAgentIdOverride?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
  agentGroupId?: string;
  /** Group space label (guild/team id) from the originating channel context. */
  agentGroupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  agentMemberRoleIds?: string[];
  sandboxed?: boolean;
  inheritedToolPolicy?: InheritedToolPolicyV2;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};
