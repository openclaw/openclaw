import type { Model } from "openclaw/plugin-sdk/llm";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import type { ExecToolDefaults } from "../bash-tools.exec-types.js";
import type { AgentRuntimeAuthPlan, AgentRuntimePlan } from "../runtime-plan/types.js";

export type CompactEmbeddedAgentSessionParams = Pick<
  import("./run/params.js").RunEmbeddedAgentParams,
  | "requireWorkspaceOnly"
  | "requireWritableSandbox"
  | "sessionTarget"
  | "sessionId"
  | "sessionKey"
  | "agentId"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "messageChannel"
  | "messageProvider"
  | "clientCaps"
  | "pinnedWidgetAuthoring"
  | "chatType"
  | "agentAccountId"
  | "conversationRoutePeerId"
  | "conversationToolPolicy"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "authProfileId"
  | "authProfileIdSource"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "memberRoleIds"
  | "spawnedBy"
  | "inputProvenance"
  | "trustedInternalHandoff"
  | "toolsAllow"
  | "disableTools"
  | "runtimePluginToolGrant"
  | "scheduledToolPolicy"
  | "workspaceDir"
  | "bootstrapWorkspaceDir"
  | "cwd"
  | "permissionMode"
  | "sessionRoot"
  | "agentDir"
  | "config"
  | "toolOverrides"
  | "skillsSnapshot"
  | "senderIsOwner"
  | "provider"
  | "model"
  | "modelFallbacksOverride"
  | "contextTokenBudget"
  | "agentHarnessId"
  | "modelSelectionLocked"
  | "thinkLevel"
  | "reasoningLevel"
  | "bashElevated"
  | "lane"
  | "enqueue"
  | "extraSystemPrompt"
  | "sourceReplyDeliveryMode"
  | "ownerNumbers"
  | "abortSignal"
  | "allowGatewaySubagentBinding"
  | "oneShotCliRun"
> & {
  /** Explicit session owner captured before fallback agent resolution. */
  contextEngineAgentId?: string;
  runId?: string;
  /** Host-resolved memory partition inherited from the compacted session. */
  memoryAudience?: import("../../plugins/memory-provider-types.js").MemoryAudience;
  /** Host-resolved sandbox fact paired with the compacted session authority. */
  memorySandboxed?: boolean;
  /** Trusted sender id from inbound context for scoped message-tool discovery. */
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  /** Host-resolved provider credential for native harness compaction. */
  resolvedApiKey?: string;
  /** Host-resolved ambient native-tool boundary for this compaction operation. */
  nativeToolSurface?: "unrestricted" | "host-isolated";
  sessionFile: string;
  /** Optional caller-observed live prompt tokens used for compaction diagnostics. */
  currentTokenCount?: number;
  /** Caller-resolved model/provider shape used by native harness compactors. */
  runtimeModel?: Model;
  /** Optional caller-resolved context engine for harness-owned compaction. */
  contextEngine?: ContextEngine;
  /** Optional caller-resolved runtime context for harness-owned context-engine compaction. */
  contextEngineRuntimeContext?: ContextEngineRuntimeContext;
  /** Resumable native CLI session targeted by an explicit manual compaction. */
  cliSessionId?: string;
  /** Complete persisted CLI binding targeted by an explicit manual compaction. */
  cliSessionBinding?: CliSessionBinding;
  /** Owning session facts required for placement and runtime preparation. */
  sessionEntry?: SessionEntry;
  /** OpenClaw-owned runtime policy prepared for this compaction path. */
  runtimePlan?: AgentRuntimePlan;
  /** Host-prepared route and credential selection for native harness compaction. */
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  execOverrides?: Pick<ExecToolDefaults, "host" | "mode" | "security" | "ask" | "node" | "nodeCwd">;
  customInstructions?: string;
  tokenBudget?: number;
  force?: boolean;
  /** Force compaction because the caller already determined this turn must compact before prompt submission. */
  forcePreflight?: boolean;
  /** Alias for forcePreflight used by preflight budget gates. */
  preflightRequired?: boolean;
  /** Diagnostic trigger that made preflight compaction mandatory. */
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
  trigger?: "budget" | "overflow" | "manual";
  /**
   * Preflight callers can allow native/current-session harness compaction but
   * move plugin-owned budget compaction onto background turn maintenance.
   */
  deferOwningContextEngineCompaction?: boolean;
  diagId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** @internal Refreshes the host watchdog when delegated native compaction makes progress. */
  compactionTimeoutReset?: () => void;
  /** @internal Host watchdog ceiling (epoch ms); the summary request ends one window before it. */
  compactionDeadlineAt?: number;
  onCompactionHookMessages?: (payload: {
    phase: "before" | "after";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
};

export type CompactEmbeddedAgentSessionRuntimeParams = Omit<
  CompactEmbeddedAgentSessionParams,
  "sessionFile"
> & {
  /** Deprecated file-backed artifact target. Prefer sessionTarget for new callers. */
  sessionFile?: string;
};
