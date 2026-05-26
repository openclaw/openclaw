import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { A as MemoryCitationsMode } from "./types.tools-B8rv6fwX.js";
import { n as EmbeddedRunTrigger } from "./params-DXH1hJUt.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-Cr5jFRhS.js";
import { n as FailoverReason, t as EmbeddedContextFile } from "./types-CqYXTtzA.js";
import { t as WorkspaceBootstrapFile } from "./workspace-CMul74hy.js";
import { a as AssembleResult, c as ContextEngine, d as ContextEnginePromptCacheInfo, f as ContextEngineRuntimeContext, y as TranscriptRewriteResult } from "./registry-f0Hu_xib.js";
import { Dr as OpenClawAgentToolResult, Sr as AgentToolResultMiddlewareEvent, _i as NormalizedUsage, bi as BuildAgentRuntimePlanParams, br as AgentToolResultMiddleware, gi as EmbeddedRunAttemptResult, hi as EmbeddedRunAttemptParams, ir as CodexAppServerExtensionFactory, or as CodexAppServerToolResultEvent, qn as ProviderRuntimeModel, rr as CodexAppServerExtensionContext, xr as AgentToolResultMiddlewareContext, yi as AgentRuntimePlan } from "./types-lCXG2pW_.js";
import { J as PluginHookLlmInputEvent, Y as PluginHookLlmOutputEvent, d as PluginHookBeforeAgentFinalizeEvent, u as PluginHookAgentEndEvent } from "./hook-types-CECscVcN.js";
import { t as SessionWriteLockAcquireTimeoutConfig } from "./sessions-DOmi4kMs.js";
import { Go as OperatorScope } from "./index-BtU77z_H.js";
import { t as SubsystemLogger } from "./subsystem-BtuMklFU.js";
import { t as ProviderRuntimePluginHandle } from "./provider-hook-runtime-C5Q8sF1-.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-CP_RkBAj.js";
import { t as BundleMcpDiagnostic } from "./bundle-mcp-CNebrzba.js";
import { a as EmbeddedPiQueueMessageOptions } from "./runs-B3uAznCF.js";
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
type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
};
type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  commandForEvent: (event: NativeHookRelayEvent) => string;
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
declare const __testing: {
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
//#region src/agents/run-cleanup-timeout.d.ts
type AgentCleanupLogger = {
  warn: (message: string) => void;
};
declare function runAgentCleanupStep(params: {
  runId: string;
  sessionId: string;
  step: string;
  cleanup: () => Promise<void>;
  log: AgentCleanupLogger;
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
//#region src/agents/bootstrap-files.d.ts
type BootstrapContextMode = "full" | "lightweight";
type BootstrapContextRunKind = "default" | "heartbeat" | "cron";
declare function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}>;
//#endregion
//#region src/config/sessions/transcript-append.d.ts
declare function appendSessionTranscriptMessage(params: {
  transcriptPath: string;
  message: unknown;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{
  messageId: string;
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
type AfterTurnRuntimeContextAttempt = Pick<EmbeddedRunAttemptParams, "sessionKey" | "sandboxSessionKey" | "messageChannel" | "messageProvider" | "agentAccountId" | "currentChannelId" | "currentThreadTs" | "currentMessageId" | "config" | "skillsSnapshot" | "senderIsOwner" | "senderId" | "provider" | "modelId" | "thinkLevel" | "reasoningLevel" | "bashElevated" | "extraSystemPrompt" | "ownerNumbers" | "authProfileId"> & {
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
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<TranscriptRewriteResult | undefined>;
/**
 * Return true when a non-legacy context engine should affect plugin harness behavior.
 */
declare function isActiveHarnessContextEngine(contextEngine: ContextEngine | undefined): contextEngine is ContextEngine;
//#endregion
//#region src/agents/harness/hook-helpers.d.ts
declare function runAgentHarnessAfterToolCallHook(params: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
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
 * @deprecated Active-run queueing is an internal runtime concern. Use current
 * runtime hooks instead of steering a harness through this legacy boolean API.
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
export { NativeHookRelayProvider as $, resolveBootstrapContextForRun as A, isMessagingTool as B, runHarnessContextEngineMaintenance as C, runAgentHarnessAfterCompactionHook as D, resolveAgentHarnessBeforePromptBuildResult as E, buildEmbeddedAttemptToolRunContext as F, selectDefaultNodeFromList as G, formatToolAggregate as H, resolveAttemptSpawnWorkspaceDir as I, classifyEmbeddedPiRunResultForModelFallback as J, NodeListNode as K, supportsModelTools as L, logAgentRuntimeToolDiagnostics as M, normalizeAgentRuntimeTools as N, runAgentHarnessBeforeCompactionHook as O, disposeRegisteredAgentHarnesses as P, NativeHookRelayEvent as Q, extractToolResultMediaArtifact as R, isActiveHarnessContextEngine as S, createCodexAppServerToolResultExtensionRunner as T, listNodes as U, isMessagingToolSendAction as V, resolveNodeIdFromList as W, log as X, buildAgentRuntimePlan as Y, runAgentCleanupStep as Z, assembleHarnessContextEngine as _, ToolProgressDetailMode as a, LoadCodexBundleMcpThreadConfigParams as at, buildHarnessContextEngineRuntimeContextFromUsage as b, inferToolMetaFromArgs as c, runAgentHarnessAgentEndHook as d, NativeHookRelayRegistrationHandle as et, runAgentHarnessBeforeAgentFinalizeHook as f, runAgentHarnessBeforeMessageWriteHook as g, runAgentHarnessAfterToolCallHook as h, TOOL_PROGRESS_OUTPUT_MAX_CHARS as i, CodexBundleMcpThreadConfig as it, normalizeProviderToolSchemas as j, appendSessionTranscriptMessage as k, loadCodexBundleMcpThreadConfig as l, runAgentHarnessLlmOutputHook as m, AgentHarnessTerminalOutcomeInput as n, buildNativeHookRelayCommand as nt, classifyAgentHarnessTerminalOutcome as o, runAgentHarnessLlmInputHook as p, callGatewayTool as q, AgentMessage$1 as r, registerNativeHookRelay as rt, formatToolProgressOutput as s, AgentHarnessTerminalOutcomeClassification as t, __testing as tt, queueAgentHarnessMessage as u, bootstrapHarnessContextEngine as v, createAgentToolResultMiddlewareRunner as w, finalizeHarnessContextEngineTurn as x, buildHarnessContextEngineRuntimeContext as y, filterToolResultMediaUrls as z };