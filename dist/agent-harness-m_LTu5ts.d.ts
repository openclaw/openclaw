import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as ModelCompatConfig } from "./types.models-tqxsISRc.js";
import { a as SourceReplyDeliveryMode } from "./get-reply-options.types-DiZecFJG.js";
import { f as ExecToolDefaults } from "./params-C8lj3xSa.js";
import { n as InboundEventKind } from "./input-provenance-DgsxhTbk.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-DcbwO2-o.js";
import { n as SkillSnapshot } from "./skills-BRkHvK1T.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { Oi as ToolOutcomeObserver } from "./types-Vx7Jq4_-2.js";
import { t as ModelAuthMode } from "./model-auth-BcP_r4Rt.js";
import { r as SandboxContext } from "./types-DqQRdgDv.js";
import { t as ProcessToolDefaults } from "./bash-tools.process-BKy5qLNB.js";
import { TSchema } from "typebox";
import { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

//#region src/agents/tool-search.d.ts
type CatalogSource = "openclaw" | "mcp" | "client";
type CatalogTool = AnyAgentTool | ToolDefinition;
type ToolSearchCatalogToolExecutor = (params: {
  tool: CatalogTool;
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
}) => Promise<AgentToolResult<unknown>>;
type ToolSearchCatalogEntry = {
  id: string;
  source: CatalogSource;
  sourceName?: string;
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
  tool: CatalogTool;
};
type ToolSearchCatalogSession = {
  entries: ToolSearchCatalogEntry[];
  searchCount: number;
  describeCount: number;
  callCount: number;
};
type ToolSearchCatalogRef = {
  current?: ToolSearchCatalogSession;
};
//#endregion
//#region src/agents/tools/media-generate-background-shared.d.ts
type MediaGenerateAsyncStartCallback = (message: string) => Promise<void> | void;
//#endregion
//#region src/agents/pi-tools.d.ts
type OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: boolean;
  includeShellTools: boolean;
  includeChannelTools: boolean;
  includeOpenClawTools: boolean;
  includePluginTools: boolean;
};
declare function createOpenClawCodingTools(options?: {
  agentId?: string;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  /**
   * The actual live run session key. When the tool set is constructed with a
   * sandbox/policy session key, this allows `session_status({sessionKey:"current"})`
   * to resolve to the live run session instead of the stale sandbox key.
   */
  runSessionKey?: string; /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string; /** Stable run identifier for this agent invocation. */
  runId?: string; /** Diagnostic trace context for hook/log correlation during this run. */
  trace?: DiagnosticTraceContext; /** What initiated this run (for trigger-specific tool restrictions). */
  trigger?: string; /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string; /** Relative workspace path that memory-triggered writes may append to. */
  memoryFlushWritePath?: string;
  agentDir?: string;
  workspaceDir?: string;
  /**
   * Workspace directory that spawned subagents should inherit.
   * When sandboxing uses a copied workspace (`ro` or `none`), workspaceDir is the
   * sandbox copy but subagents should inherit the real agent workspace instead.
   * Defaults to workspaceDir when not set.
   */
  spawnWorkspaceDir?: string;
  config?: OpenClawConfig;
  abortSignal?: AbortSignal; /** Disable hook-owned diagnostics when an outer runtime owns tool diagnostics. */
  emitBeforeToolCallDiagnostics?: boolean;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string; /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string; /** Model API for the current provider (used for provider-native tool arbitration). */
  modelApi?: string; /** Model context window in tokens (used to scale read-tool output budget). */
  modelContextWindowTokens?: number; /** Resolved runtime model compatibility hints. */
  modelCompat?: ModelCompatConfig; /** If false, keep OpenClaw web_search even when a provider-native search tool is active. */
  suppressManagedWebSearch?: boolean;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode; /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string; /** Normalized conversation id exposed to tool hooks. Defaults to currentChannelId. */
  hookChannelId?: string; /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string; /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number; /** Group id for channel-level tool policy resolution. */
  groupId?: string | null; /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null; /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null; /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[]; /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null; /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched"; /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: {
    value: boolean;
  }; /** Allow plugin tools for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean; /** Runtime-scoped explicit allowlist used to materialize matching plugin tools. */
  runtimeToolAllowlist?: string[]; /** If true, the model has native vision capability */
  modelHasVision?: boolean; /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean; /** Visible source replies must be sent through the message tool when set to message_tool_only. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  inboundEventKind?: InboundEventKind; /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean; /** Keep the message tool available even when the selected profile omits it. */
  forceMessageTool?: boolean; /** Include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean; /** Keep the heartbeat response tool available even when the selected profile omits it. */
  forceHeartbeatTool?: boolean; /** If false, build plugin tools only while preserving the shared policy pipeline. */
  includeCoreTools?: boolean; /** Include Tool Search control tools when enabled for this run. */
  includeToolSearchControls?: boolean; /** Executes cataloged tools through the active PI run lifecycle. */
  toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor; /** Runtime-local Tool Search catalog ref shared with PI attempt compaction. */
  toolSearchCatalogRef?: ToolSearchCatalogRef; /** Limits which tool families are materialized before the shared policy pipeline runs. */
  toolConstructionPlan?: OpenClawCodingToolConstructionPlan; /** Trusted sender identity bit for command/channel-action auth; does not filter model tools. */
  senderIsOwner?: boolean; /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
  authProfileStore?: AuthProfileStore; /** Callback invoked when sessions_yield tool is called. */
  onYield?: (message: string) => Promise<void> | void; /** Callback invoked when a media tool starts async background work. */
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback; /** Optional instrumentation callback for tool preparation stage timing. */
  recordToolPrepStage?: (name: string) => void; /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver; /** Runtime-only resolved skill paths that the read tool may load under workspaceOnly. */
  skillsSnapshot?: SkillSnapshot;
}): AnyAgentTool[];
//#endregion
export { createOpenClawCodingTools as t };