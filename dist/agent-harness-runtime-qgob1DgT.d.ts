import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { j as MemoryCitationsMode } from "./types.tools-BpgZArJS.js";
import { n as EmbeddedRunTrigger } from "./params-C8lj3xSa.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-DcbwO2-o.js";
import { n as FailoverReason } from "./types-DKoVBm0H.js";
import { _ as ContextEngineRuntimeContext, c as CompactResult, g as ContextEnginePromptCacheInfo, l as ContextEngine, o as AssembleResult, w as TranscriptRewriteResult } from "./registry-DoCIDswp.js";
import { Ci as NormalizedUsage, Dr as AgentToolResultMiddlewareEvent, Ei as BuildAgentRuntimePlanParams, Er as AgentToolResultMiddlewareContext, Mr as OpenClawAgentToolResult, Qn as ProviderRuntimeModel, Si as PreemptiveCompactionRoute, Ti as AgentRuntimePlan, Tr as AgentToolResultMiddleware, bi as EmbeddedRunAttemptParams, cr as CodexAppServerExtensionContext, dr as CodexAppServerToolResultEvent, lr as CodexAppServerExtensionFactory, xi as EmbeddedRunAttemptResult } from "./types-Vx7Jq4_-2.js";
import { P as PluginHookContextWindowSource, X as PluginHookLlmOutputEvent, Y as PluginHookLlmInputEvent, d as PluginHookBeforeAgentFinalizeEvent, l as PluginHookAgentContext, u as PluginHookAgentEndEvent } from "./hook-types-BKz-S4lu.js";
import { Go as OperatorScope } from "./index-CaLNQFzV.js";
import { t as SubsystemLogger } from "./subsystem-Ce5qcC5n.js";
import { t as ProviderRuntimePluginHandle } from "./provider-hook-runtime-5QGHpPQz.js";
import { o as EmbeddedPiQueueMessageOptions } from "./runs-CcRxGsix.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BcGIYLRB.js";
import { t as BundleMcpDiagnostic } from "./bundle-mcp-DABlFCpS.js";
import { t as SessionWriteLockAcquireTimeoutConfig } from "./session-write-lock-20UNZM3a.js";
import { TSchema } from "typebox";
import { AgentMessage, AgentMessage as AgentMessage$1, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

//#region src/agents/codex-mcp-config.types.d.ts
type CodexMcpServersConfig = Record<string, Record<string, unknown>>;
type CodexBundleMcpThreadConfig = {
  configPatch?: {
    mcp_servers: CodexMcpServersConfig;
  };
  diagnostics: BundleMcpDiagnostic[];
  evaluated: boolean;
  fingerprint?: string;
};
type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
};
//#endregion
//#region src/agents/harness/native-hook-relay.d.ts
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
declare const NATIVE_HOOK_RELAY_EVENTS: readonly ["pre_tool_use", "post_tool_use", "permission_request", "before_agent_finalize"];
declare const NATIVE_HOOK_RELAY_PROVIDERS: readonly ["codex"];
type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];
type NativeHookRelayInvocation = {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  nativeEventName?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  cwd?: string;
  model?: string;
  turnId?: string;
  transcriptPath?: string;
  permissionMode?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  toolName?: string;
  toolUseId?: string;
  rawPayload: JsonValue;
  receivedAt: string;
};
type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
};
type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  shouldRelayEvent: (event: NativeHookRelayEvent) => boolean;
  commandForEvent: (event: NativeHookRelayEvent) => string;
  renew: (ttlMs?: number) => void;
  unregister: () => void;
};
type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  relayId?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  allowedEvents?: readonly NativeHookRelayEvent[];
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
};
type NativeHookRelayCommandOptions = {
  executable?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
};
type InvokeNativeHookRelayParams = {
  provider: unknown;
  relayId: unknown;
  event: unknown;
  rawPayload: unknown;
};
type NativeHookRelayPermissionDecision = "allow" | "deny";
type NativeHookRelayPermissionApprovalResult = NativeHookRelayPermissionDecision | "allow-always" | "defer";
type NativeHookRelayPermissionApprovalRequest = {
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  cwd?: string;
  model?: string;
  toolInput: Record<string, JsonValue>;
  signal?: AbortSignal;
};
type NativeHookRelayPermissionApprovalRequester = (request: NativeHookRelayPermissionApprovalRequest) => Promise<NativeHookRelayPermissionApprovalResult>;
declare function registerNativeHookRelay(params: RegisterNativeHookRelayParams): NativeHookRelayRegistrationHandle;
declare function buildNativeHookRelayCommand(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  timeoutMs?: number;
  executable?: string;
  nodeExecutable?: string;
}): string;
declare function invokeNativeHookRelay(params: InvokeNativeHookRelayParams): Promise<NativeHookRelayProcessResponse>;
declare function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean;
declare const testing: {
  readonly clearNativeHookRelaysForTests: () => void;
  readonly getNativeHookRelayInvocationsForTests: () => NativeHookRelayInvocation[];
  readonly getNativeHookRelayRegistrationForTests: (relayId: string) => NativeHookRelayRegistration | undefined;
  readonly getNativeHookRelayBridgeDirForTests: () => string;
  readonly getNativeHookRelayBridgeRegistryPathForTests: (relayId: string) => string;
  readonly getNativeHookRelayBridgeRecordForTests: (relayId: string) => Record<string, unknown> | undefined;
  readonly formatPermissionApprovalDescriptionForTests: (request: NativeHookRelayPermissionApprovalRequest) => string;
  readonly permissionRequestContentFingerprintForTests: (request: NativeHookRelayPermissionApprovalRequest) => string;
  readonly permissionRequestToolInputKeyFingerprintForTests: (toolInput: Record<string, unknown>) => string;
  readonly setNativeHookRelayPermissionApprovalRequesterForTests: (requester: NativeHookRelayPermissionApprovalRequester) => void;
};
//#endregion
//#region src/plugins/hook-agent-context.d.ts
declare function buildAgentHookContextChannelFields(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): Pick<PluginHookAgentContext, "channelId" | "messageProvider">;
//#endregion
//#region src/agents/run-cleanup-timeout.d.ts
type AgentCleanupLogger = {
  warn: (message: string) => void;
};
declare function runAgentCleanupStep(params: {
  runId: string;
  sessionId: string;
  step: string;
  cleanup: () => Promise<void>;
  getTimeoutDetails?: () => string | undefined;
  log: AgentCleanupLogger;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void>;
//#endregion
//#region src/agents/pi-embedded-runner/logger.d.ts
declare const log: SubsystemLogger;
//#endregion
//#region src/agents/runtime-plan/build.d.ts
declare function buildAgentRuntimePlan(params: BuildAgentRuntimePlanParams): AgentRuntimePlan;
//#endregion
//#region src/agents/model-fallback.d.ts
type ModelFallbackResultClassification = {
  message: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  rawError?: string;
} | {
  error: unknown;
} | null | undefined;
//#endregion
//#region src/agents/pi-embedded-runner/result-fallback-classifier.d.ts
declare function classifyEmbeddedPiRunResultForModelFallback(params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}): ModelFallbackResultClassification;
//#endregion
//#region src/agents/tools/gateway.d.ts
type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};
declare function callGatewayTool<T = Record<string, unknown>>(method: string, opts: GatewayCallOptions, params?: unknown, extra?: {
  expectFinal?: boolean;
  scopes?: OperatorScope[];
}): Promise<T>;
//#endregion
//#region src/shared/node-list-types.d.ts
type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  pathEnv?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
  connectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  approvedAtMs?: number;
};
//#endregion
//#region src/agents/tools/nodes-utils.d.ts
type DefaultNodeFallback = "none" | "first";
type DefaultNodeSelectionOptions = {
  capability?: string;
  fallback?: DefaultNodeFallback;
  preferLocalMac?: boolean;
};
declare function selectDefaultNodeFromList(nodes: NodeListNode[], options?: DefaultNodeSelectionOptions): NodeListNode | null;
declare function listNodes(opts: GatewayCallOptions): Promise<NodeListNode[]>;
declare function resolveNodeIdFromList(nodes: NodeListNode[], query?: string, allowDefault?: boolean): string;
//#endregion
//#region src/auto-reply/tool-meta.d.ts
type ToolAggregateOptions = {
  markdown?: boolean;
};
declare function formatToolAggregate(toolName?: string, metas?: string[], options?: ToolAggregateOptions): string;
//#endregion
//#region src/agents/pi-embedded-messaging.d.ts
declare function isMessagingTool(toolName: string): boolean;
declare function isMessagingToolSendAction(toolName: string, args: Record<string, unknown>): boolean;
//#endregion
//#region src/agents/pi-embedded-subscribe.tools.d.ts
declare function filterToolResultMediaUrls(toolName: string | undefined, mediaUrls: string[], result?: unknown, builtinToolNames?: ReadonlySet<string>): string[];
/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Read structured `details.media` attachments from tool details.
 * 2. Parse `MEDIA:` directive tokens from text content blocks.
 * 3. Fall back to `details.path` when image content exists (legacy imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
type ToolResultMediaArtifact = {
  mediaUrls: string[];
  audioAsVoice?: boolean;
  trustedLocalMedia?: boolean;
};
declare function extractToolResultMediaArtifact(result: unknown): ToolResultMediaArtifact | undefined;
//#endregion
//#region src/agents/model-tool-support.d.ts
declare function supportsModelTools(model: {
  compat?: unknown;
}): boolean;
//#endregion
//#region src/agents/pi-embedded-runner/run/attempt.thread-helpers.d.ts
declare function resolveAttemptSpawnWorkspaceDir(params: {
  sandbox?: {
    enabled?: boolean;
    workspaceAccess?: string;
  } | null;
  resolvedWorkspace: string;
}): string | undefined;
//#endregion
//#region src/agents/pi-embedded-runner/run/attempt.tool-run-context.d.ts
declare function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  toolsAllow?: string[];
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  runtimeToolAllowlist?: string[];
  trace?: DiagnosticTraceContext;
};
//#endregion
//#region src/agents/harness/registry.d.ts
declare function disposeRegisteredAgentHarnesses(): Promise<void>;
//#endregion
//#region src/agents/runtime-plan/tools.d.ts
type AgentRuntimeToolPolicyParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  runtimePlan?: AgentRuntimePlan;
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
};
declare function normalizeAgentRuntimeTools<TSchemaType extends TSchema = TSchema, TResult = unknown>(params: AgentRuntimeToolPolicyParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[];
declare function logAgentRuntimeToolDiagnostics(params: AgentRuntimeToolPolicyParams): void;
//#endregion
//#region src/agents/pi-embedded-runner/tool-schema-runtime.d.ts
type ProviderToolSchemaParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
};
/**
 * Runs provider-owned tool-schema normalization without encoding provider
 * families in the embedded runner.
 */
declare function normalizeProviderToolSchemas<TSchemaType extends TSchema = TSchema, TResult = unknown>(params: ProviderToolSchemaParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[];
//#endregion
//#region src/agents/sandbox/fs-paths.d.ts
declare function resolveWritableSandboxBindHostRoots(binds: readonly string[] | undefined): string[];
declare function hasSandboxBindContainerPathAliases(binds: readonly string[] | undefined): boolean;
declare function hasSandboxBindReadonlyHostShadows(binds: readonly string[] | undefined): boolean;
//#endregion
//#region src/config/sessions/transcript-append.d.ts
type AppendSessionTranscriptMessageParams<TMessage = unknown> = {
  transcriptPath: string;
  message: TMessage;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  config?: OpenClawConfig;
};
declare function appendSessionTranscriptMessage<TMessage>(params: AppendSessionTranscriptMessageParams<TMessage>): Promise<{
  messageId: string;
  message: TMessage;
}>;
//#endregion
//#region src/agents/harness/hook-context.d.ts
type AgentHarnessHookContext = {
  runId: string;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
  contextTokenBudget?: number;
  contextWindowSource?: PluginHookContextWindowSource;
  contextWindowReferenceTokens?: number;
};
//#endregion
//#region src/agents/harness/prompt-compaction-hook-helpers.d.ts
type AgentHarnessPromptBuildResult = {
  prompt: string;
  developerInstructions: string;
};
declare function resolveAgentHarnessBeforePromptBuildResult(params: {
  prompt: string;
  developerInstructions: string;
  messages: unknown[];
  ctx: AgentHarnessHookContext;
}): Promise<AgentHarnessPromptBuildResult>;
declare function runAgentHarnessBeforeCompactionHook(params: {
  sessionFile: string;
  messages: AgentMessage[];
  ctx: AgentHarnessHookContext;
}): Promise<void>;
declare function runAgentHarnessAfterCompactionHook(params: {
  sessionFile: string;
  messages: AgentMessage[];
  ctx: AgentHarnessHookContext;
  compactedCount: number;
}): Promise<void>;
//#endregion
//#region src/agents/harness/codex-app-server-extensions.d.ts
declare function createCodexAppServerToolResultExtensionRunner(ctx: CodexAppServerExtensionContext, factories?: CodexAppServerExtensionFactory[]): {
  applyToolResultExtensions(event: CodexAppServerToolResultEvent): Promise<AgentToolResult<unknown>>;
};
//#endregion
//#region src/agents/harness/tool-result-middleware.d.ts
declare function createAgentToolResultMiddlewareRunner(ctx: AgentToolResultMiddlewareContext, handlers?: AgentToolResultMiddleware[]): {
  applyToolResultMiddleware(event: AgentToolResultMiddlewareEvent): Promise<OpenClawAgentToolResult>;
};
//#endregion
//#region src/agents/pi-embedded-runner/run/attempt.prompt-helpers.d.ts
type AfterTurnRuntimeContextAttempt = Pick<EmbeddedRunAttemptParams, "sessionKey" | "sandboxSessionKey" | "messageChannel" | "messageProvider" | "agentAccountId" | "currentChannelId" | "currentThreadTs" | "currentMessageId" | "config" | "skillsSnapshot" | "senderId" | "provider" | "modelId" | "thinkLevel" | "reasoningLevel" | "bashElevated" | "extraSystemPrompt" | "ownerNumbers" | "authProfileId"> & {
  sessionId?: EmbeddedRunAttemptParams["sessionId"];
};
/** Build runtime context passed into context-engine afterTurn hooks. */
declare function buildAfterTurnRuntimeContext(params: {
  attempt: AfterTurnRuntimeContextAttempt;
  workspaceDir: string;
  agentDir: string;
  activeAgentId?: string;
  contextEnginePluginId?: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext;
declare function buildAfterTurnRuntimeContextFromUsage(params: Omit<Parameters<typeof buildAfterTurnRuntimeContext>[0], "currentTokenCount"> & {
  lastCallUsage?: NormalizedUsage;
}): ContextEngineRuntimeContext;
//#endregion
//#region src/agents/harness/context-engine-lifecycle.d.ts
type HarnessContextEngine = ContextEngine;
/**
 * Run optional bootstrap + bootstrap maintenance for a harness-owned context engine.
 */
declare function bootstrapHarnessContextEngine(params: {
  hadSessionFile: boolean;
  contextEngine?: HarnessContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionManager?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
  runMaintenance?: typeof runHarnessContextEngineMaintenance;
  config?: SessionWriteLockAcquireTimeoutConfig;
  warn: (message: string) => void;
}): Promise<void>;
/**
 * Assemble model context through the active harness-owned context engine.
 */
declare function assembleHarnessContextEngine(params: {
  contextEngine?: HarnessContextEngine;
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
  modelId: string;
  prompt?: string;
}): Promise<AssembleResult | undefined>;
/**
 * Finalize a completed harness turn via afterTurn or ingest fallbacks.
 */
declare function finalizeHarnessContextEngineTurn(params: {
  contextEngine?: HarnessContextEngine;
  promptError: boolean;
  aborted: boolean;
  yieldAborted: boolean;
  sessionIdUsed: string;
  sessionKey?: string;
  sessionFile: string;
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  tokenBudget?: number;
  runtimeContext?: ContextEngineRuntimeContext;
  runMaintenance?: typeof runHarnessContextEngineMaintenance;
  sessionManager?: unknown;
  config?: SessionWriteLockAcquireTimeoutConfig;
  warn: (message: string) => void;
}): Promise<{
  postTurnFinalizationSucceeded: boolean;
}>;
/**
 * Build runtime context passed into harness context-engine hooks.
 */
declare function buildHarnessContextEngineRuntimeContext(params: Parameters<typeof buildAfterTurnRuntimeContext>[0]): ContextEngineRuntimeContext;
/**
 * Build runtime context passed into harness context-engine hooks from usage data.
 */
declare function buildHarnessContextEngineRuntimeContextFromUsage(params: Parameters<typeof buildAfterTurnRuntimeContextFromUsage>[0]): ContextEngineRuntimeContext;
/**
 * Run optional transcript maintenance for a harness-owned context engine.
 */
declare function runHarnessContextEngineMaintenance(params: {
  contextEngine?: HarnessContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
  executionMode?: "foreground" | "background";
  onDeferredMaintenance?: (promise: Promise<void>) => void;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<TranscriptRewriteResult | undefined>;
/**
 * Return true when a non-legacy context engine should affect plugin harness behavior.
 */
declare function isActiveHarnessContextEngine(contextEngine: ContextEngine | undefined): contextEngine is ContextEngine;
//#endregion
//#region src/agents/pi-embedded-runner/compaction-safety-timeout.d.ts
declare function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number;
/** Parameters for a single {@link ContextEngine.compact} invocation. */
type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];
/**
 * Invoke a plugin-owned {@link ContextEngine.compact} bounded by the same
 * finite safety timeout that protects native runtime compaction.
 *
 * Plugin context engines that advertise `ownsCompaction` previously had their
 * `compact()` awaited with no timeout, no watchdog, and no abort signal — a
 * slow or hung plugin compaction would hang the agent turn indefinitely. This
 * wrapper closes that gap:
 *  - the call is bounded by `timeoutMs` (host-resolved, default
 *    {@link EMBEDDED_COMPACTION_TIMEOUT_MS}); on timeout it rejects with a
 *    "Compaction timed out" error so the caller's existing failure handling
 *    runs instead of hanging;
 *  - the timeout signal and caller `abortSignal` are both raced against the
 *    call (so a non-cooperating engine is still bounded) and threaded into the
 *    `compact()` params (so cooperating engines can cancel their own in-flight
 *    work).
 *
 * Callers keep their existing try/catch — a timeout or abort surfaces as a
 * thrown error, never a silent hang.
 */
declare function compactContextEngineWithSafetyTimeout(contextEngine: Pick<ContextEngine, "compact">, params: ContextEngineCompactParams, timeoutMs?: number, abortSignal?: AbortSignal): Promise<CompactResult>;
//#endregion
//#region src/agents/pi-embedded-runner/run/preemptive-compaction.d.ts
declare const PREEMPTIVE_OVERFLOW_ERROR_TEXT = "Context overflow: prompt too large for the model (precheck).";
type PreemptiveCompactionDecision = {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  pressureSource?: string;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};
type LlmBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  renderedChars?: number;
};
declare function estimateRenderedLlmBoundaryTokenPressure(params: {
  systemPrompt?: string;
  prompt: string;
}): number;
declare function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  llmBoundaryTokenPressure?: LlmBoundaryTokenPressure;
}): PreemptiveCompactionDecision;
declare function formatPrePromptPrecheckLog(params: {
  result: PreemptiveCompactionDecision;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionFile?: string;
}): string;
//#endregion
//#region src/agents/harness/hook-helpers.d.ts
declare function runAgentHarnessAfterToolCallHook(params: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
  startArgs: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt?: number;
}): Promise<void>;
declare function runAgentHarnessBeforeMessageWriteHook(params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}): AgentMessage | null;
//#endregion
//#region src/agents/harness/lifecycle-hook-helpers.d.ts
type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;
declare function runAgentHarnessLlmInputHook(params: {
  event: PluginHookLlmInputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void;
declare function runAgentHarnessLlmOutputHook(params: {
  event: PluginHookLlmOutputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void;
declare function runAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void;
declare function awaitAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<void>;
type AgentHarnessBeforeAgentFinalizeOutcome = {
  action: "continue";
} | {
  action: "revise";
  reason: string;
} | {
  action: "finalize";
  reason?: string;
};
declare function runAgentHarnessBeforeAgentFinalizeHook(params: {
  event: PluginHookBeforeAgentFinalizeEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<AgentHarnessBeforeAgentFinalizeOutcome>;
//#endregion
//#region src/plugin-sdk/agent-harness-runtime.d.ts
declare const TOOL_PROGRESS_OUTPUT_MAX_CHARS = 8000;
/**
 * @deprecated Active-run queueing is an internal runtime concern. This legacy
 * boolean API only reports immediate queue eligibility and cannot observe async
 * runtime rejection; runtime-owned delivery paths should use acceptance-aware
 * steering instead of public SDK queueing.
 */
declare function queueAgentHarnessMessage(sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions): boolean;
declare function loadCodexBundleMcpThreadConfig(params: LoadCodexBundleMcpThreadConfigParams): Promise<CodexBundleMcpThreadConfig>;
/**
 * Derive the same compact user-facing tool detail that Pi uses for progress logs.
 */
type ToolProgressDetailMode = "explain" | "raw";
declare function inferToolMetaFromArgs(toolName: string, args: unknown, options?: {
  detailMode?: ToolProgressDetailMode;
}): string | undefined;
/**
 * Prepare verbose tool output for user-facing progress messages.
 */
declare function formatToolProgressOutput(output: string, options?: {
  maxChars?: number;
}): string | undefined;
type AgentHarnessTerminalOutcomeInput = {
  assistantTexts: readonly string[];
  reasoningText?: string | null;
  planText?: string | null;
  promptError?: unknown;
  turnCompleted: boolean;
};
type AgentHarnessTerminalOutcomeClassification = NonNullable<EmbeddedRunAttemptResult["agentHarnessResultClassification"]>;
/**
 * Classify terminal harness turns that completed without assistant output that
 * should advance fallback. Deliberate silent replies such as NO_REPLY count as
 * intentional output, while whitespace-only text remains fallback-eligible.
 * This is intentionally SDK-level so plugin harness adapters such as Codex
 * preserve the same OpenClaw-owned fallback signals as the built-in PI path
 * without re-implementing terminal-result policy.
 */
declare function classifyAgentHarnessTerminalOutcome(params: AgentHarnessTerminalOutcomeInput): AgentHarnessTerminalOutcomeClassification | undefined;
//#endregion
export { formatToolAggregate as $, finalizeHarnessContextEngineTurn as A, hasSandboxBindReadonlyHostShadows as B, shouldPreemptivelyCompactBeforePrompt as C, bootstrapHarnessContextEngine as D, assembleHarnessContextEngine as E, resolveAgentHarnessBeforePromptBuildResult as F, disposeRegisteredAgentHarnesses as G, normalizeProviderToolSchemas as H, runAgentHarnessAfterCompactionHook as I, supportsModelTools as J, buildEmbeddedAttemptToolRunContext as K, runAgentHarnessBeforeCompactionHook as L, runHarnessContextEngineMaintenance as M, createAgentToolResultMiddlewareRunner as N, buildHarnessContextEngineRuntimeContext as O, createCodexAppServerToolResultExtensionRunner as P, isMessagingToolSendAction as Q, appendSessionTranscriptMessage as R, formatPrePromptPrecheckLog as S, resolveCompactionTimeoutMs as T, logAgentRuntimeToolDiagnostics as U, resolveWritableSandboxBindHostRoots as V, normalizeAgentRuntimeTools as W, filterToolResultMediaUrls as X, extractToolResultMediaArtifact as Y, isMessagingTool as Z, runAgentHarnessBeforeMessageWriteHook as _, registerNativeHookRelay as _t, ToolProgressDetailMode as a, classifyEmbeddedPiRunResultForModelFallback as at, PreemptiveCompactionDecision as b, LoadCodexBundleMcpThreadConfigParams as bt, inferToolMetaFromArgs as c, runAgentCleanupStep as ct, awaitAgentHarnessAgentEndHook as d, NativeHookRelayProcessResponse as dt, listNodes as et, runAgentHarnessAgentEndHook as f, NativeHookRelayProvider as ft, runAgentHarnessAfterToolCallHook as g, invokeNativeHookRelay as gt, runAgentHarnessLlmOutputHook as h, hasNativeHookRelayInvocation as ht, TOOL_PROGRESS_OUTPUT_MAX_CHARS as i, callGatewayTool as it, isActiveHarnessContextEngine as j, buildHarnessContextEngineRuntimeContextFromUsage as k, loadCodexBundleMcpThreadConfig as l, buildAgentHookContextChannelFields as lt, runAgentHarnessLlmInputHook as m, buildNativeHookRelayCommand as mt, AgentHarnessTerminalOutcomeInput as n, selectDefaultNodeFromList as nt, classifyAgentHarnessTerminalOutcome as o, buildAgentRuntimePlan as ot, runAgentHarnessBeforeAgentFinalizeHook as p, NativeHookRelayRegistrationHandle as pt, resolveAttemptSpawnWorkspaceDir as q, AgentMessage$1 as r, NodeListNode as rt, formatToolProgressOutput as s, log as st, AgentHarnessTerminalOutcomeClassification as t, resolveNodeIdFromList as tt, queueAgentHarnessMessage as u, NativeHookRelayEvent as ut, LlmBoundaryTokenPressure as v, testing as vt, compactContextEngineWithSafetyTimeout as w, estimateRenderedLlmBoundaryTokenPressure as x, PREEMPTIVE_OVERFLOW_ERROR_TEXT as y, CodexBundleMcpThreadConfig as yt, hasSandboxBindContainerPathAliases as z };