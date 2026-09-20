import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { GroupToolPolicyConfig } from "../config/types.tools.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { SkillSnapshot, SkillUsagePath } from "../skills/types.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import type { ToolOutcomeObserver } from "./agent-tools.before-tool-call.js";
import type { SkillInstructionDeliveryCache } from "./agent-tools.read.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import type {
  AgentRunClientContext,
  AgentRunMessageContext,
  AgentRunChannelContext,
} from "./command/shared-types.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import type { OpenClawCodingToolConstructionPlan } from "./core-tool-factory-descriptors.js";
import type { DelegationCapability } from "./delegation-capability.js";
import type { ModelAuthMode } from "./model-auth.js";
import type { OpenClawSharedToolsOptions } from "./openclaw-tools.types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import type { SandboxContext } from "./sandbox.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { TrustedSubagentCompletionHandoff } from "./subagents/announce/subagent-announce-handoff.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.js";
import type {
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
  ToolSearchToolContext,
} from "./tool-search.js";
import type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./tools/cron-tool.js";

/** Public options for building one plugin-owned agent tool surface. */
export type OpenClawCodingToolsOptions = {
  agentId?: string;
  /** Retained policy owner; execution identity remains agentId/runSessionKey. */
  policyAgentId?: string;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  /** Specific ingress provider used only for transport tool availability. */
  toolPolicyMessageProvider?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  requesterThinkingLevel?: ThinkLevel;
  requesterModel?: SpawnedToolContext["requesterModel"];
  /** Exact admitted run instance for lifecycle-bound subprocess capabilities. */
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Host-prepared effective paired-node Computer Use surface. */
  pairedNodeComputerUse?: import("./computer-use-node-capabilities.js").PreparedPairedComputerUse;
  /** Diagnostic trace context for hook/log correlation during this run. */
  trace?: DiagnosticTraceContext;
  /** What initiated this run (for trigger-specific tool restrictions). */
  trigger?: string;
  /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string;
  /** Relative workspace path that memory-triggered writes may append to. */
  memoryFlushWritePath?: string;
  agentDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  /** Additional containment for a trusted scheduled workspace; never weakens configured policy. */
  requireWorkspaceOnly?: true;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  abortSignal?: AbortSignal;
  /** Disable hook-owned diagnostics when an outer runtime owns tool diagnostics. */
  emitBeforeToolCallDiagnostics?: boolean;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /** Attempt-local authority to start or redirect delegated work. */
  delegationCapability?: DelegationCapability;
  /** Model API for the current provider (used for provider-native tool arbitration). */
  modelApi?: string;
  /** Model context window in tokens (used to scale read-tool output budget). */
  modelContextWindowTokens?: number;
  /** Resolved runtime model compatibility hints. */
  modelCompat?: ModelCompatConfig;
  /** If false, keep OpenClaw web_search even when a provider-native search tool is active. */
  suppressManagedWebSearch?: boolean;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Normalized conversation id exposed to tool hooks. Defaults to currentChannelId. */
  hookChannelId?: string;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  /** True when runtimeToolAllowlist is real parent authority that child sessions inherit. */
  inheritRuntimeToolAllowlist?: boolean;
  /** Mutable spawn capability snapshot refreshed after late-bound runtime tools are authorized. */
  inheritedToolAllowlistRef?: string[];
  /** Mutable cron creator cap ref for callers that append final runtime tools later. */
  cronCreatorToolAllowlistRef?: CronCreatorToolAllowlistEntry[];
  /** Mutable proof that the cron cap reached the final executable surface. */
  cronCreatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Attempt-local full skill reads that remain visible in the model context. */
  skillInstructionDeliveryCache?: SkillInstructionDeliveryCache;
  /** Keep the message tool available even when the selected profile omits it. */
  forceMessageTool?: boolean;
  /** Keep the heartbeat response tool available even when the selected profile omits it. */
  forceHeartbeatTool?: boolean;
  /** If false, build plugin tools only while preserving the shared policy pipeline. */
  includeCoreTools?: boolean;
  /** Include Tool Search control tools when enabled for this run. */
  includeToolSearchControls?: boolean;
  /** Executes cataloged tools through the active agent run lifecycle. */
  toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor;
  /** Runtime-local Tool Search catalog ref shared with attempt compaction. */
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  /** Already-admitted skill locations for mistaken tool-id recovery. */
  codeModeSkills?: ToolSearchToolContext["codeModeSkills"];
  /** Limits which tool families are materialized before the shared policy pipeline runs. */
  toolConstructionPlan?: OpenClawCodingToolConstructionPlan;
  /** Ring-zero OpenClaw tool; set only by the OpenClaw agent runner. */
  systemAgentTool?: import("./tools/system-agent-tool.js").SystemAgentToolOptions;
  /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
  authProfileStore?: AuthProfileStore;
  /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  /** Reads the sticky untrusted-content flag for the current user turn. */
  isTurnTainted?: () => boolean;
  /** Supplies run-global model-call ordering for parallel tool outcomes. */
  allocateToolOutcomeOrdinal?: (toolCallId?: string) => number;
  /** Runtime-only resolved skill paths that the read tool may load under workspaceOnly. */
  skillsSnapshot?: SkillSnapshot;
  /** Original identities for sandbox-materialized skill instruction paths. */
  skillUsagePaths?: SkillUsagePath[];
  /** Prepared conversation-scoped facts for callers that already resolved this run context. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  /** Trusted conversation policy prepared at channel ingress. */
  conversationToolPolicy?: GroupToolPolicyConfig;
  inputProvenance?: InputProvenance;
  /** Consumed in-process completion capability; never derived from model-facing input. */
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
} & OpenClawSharedToolsOptions &
  AgentRunClientContext &
  AgentRunMessageContext &
  AgentRunChannelContext;
