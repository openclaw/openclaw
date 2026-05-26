import { On as CliBackendConfig, i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { l as ModelProviderAuthMode, o as ModelCompatConfig, u as ModelProviderConfig } from "./types.models-tqxsISRc.js";
import { x as ToolLoopDetectionConfig } from "./types.tools-BpgZArJS.js";
import { t as ModelProviderRequestTransportOverrides$1 } from "./provider-request-config-Ckb2OLir.js";
import { r as EmbeddingProviderAdapter } from "./embedding-providers-BwXHOC_w.js";
import { n as PluginConfigUiHint } from "./manifest-types-C_IWdo1j.js";
import { t as JsonSchemaObject } from "./json-schema.types-fpZiub1R.js";
import { d as PluginKind, f as UnifiedModelCatalogEntry, p as UnifiedModelCatalogKind } from "./manifest-registry-CMekBFSM.js";
import { n as ReasoningLevel, r as ThinkLevel } from "./thinking.shared-DZFlsfdo.js";
import { a as SourceReplyDeliveryMode, n as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { S as HeartbeatToolResponse, _ as AgentRunTimeoutPhase, a as BlockReplyChunking, b as AcceptedSessionSpawn, d as ExecElevatedDefaults, g as EmbeddedRunLivenessState, i as PromptMode, p as EmbeddedPiCompactResult, r as RunEmbeddedPiAgentParams, v as MessagingToolSend, y as MessagingToolSourceReplyPayload } from "./params-C8lj3xSa.js";
import { t as CommandQueueEnqueueFn } from "./command-queue.types-CfUiTJN8.js";
import { s as SandboxFsBridge } from "./backend-handle.types-D7afWmft.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { t as DeliveryContext } from "./delivery-context.types-DsJXWtUi.js";
import { c as SessionSystemPromptReport, o as SessionEntry } from "./types-ChLEnNVH.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-DcbwO2-o.js";
import { n as FailoverReason } from "./types-DKoVBm0H.js";
import { n as SkillSnapshot } from "./skills-BRkHvK1T.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-LYni1Yjz.js";
import { E as OpenClawPluginHookOptions, L as WebFetchProviderPlugin, O as OpenClawPluginToolFactory, U as WebSearchProviderPlugin, k as OpenClawPluginToolOptions } from "./types-core-DxqEkbXr.js";
import { c as OAuthCredential, i as AuthProfileCredential, s as AuthProfileStore, t as ApiKeyCredential } from "./types-BwDj5PsX.js";
import { f as MediaUnderstandingProvider } from "./types-ByzWuf9L.js";
import { l as ImageGenerationProvider } from "./types-BaGDaXQN.js";
import { s as VideoGenerationProvider } from "./types-Dcgt3eyW.js";
import { c as MusicGenerationProvider } from "./types-M_PrR5fi.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { i as WizardPrompter } from "./prompts-DgKIGa-v.js";
import { t as SecretInputMode } from "./provider-auth-types-C72FsWut.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { A as SpeechSynthesisRequest, C as SpeechProviderId, D as SpeechProviderResolveConfigContext, E as SpeechProviderPreparedSynthesis, F as SpeechTelephonySynthesisRequest, I as SpeechTelephonySynthesisResult, L as SpeechVoiceOption, M as SpeechSynthesisStreamRequest, N as SpeechSynthesisStreamResult, O as SpeechProviderResolveTalkConfigContext, S as SpeechProviderConfiguredContext, T as SpeechProviderPrepareSynthesisContext, _ as SpeechDirectiveTokenParseContext, j as SpeechSynthesisResult, k as SpeechProviderResolveTalkOverridesContext, v as SpeechDirectiveTokenParseResult, x as SpeechProviderConfig, y as SpeechListVoicesRequest } from "./tts-runtime.types-DsGX4LDs.js";
import { n as DetachedTaskLifecycleRuntime } from "./detached-task-runtime-contract-UNgNSDOU.js";
import { _ as ContextEngineRuntimeContext, g as ContextEnginePromptCacheInfo, l as ContextEngine, t as ContextEngineFactory, u as ContextEngineHostCapability } from "./registry-DoCIDswp.js";
import { f as MemoryPluginRuntime, o as MemoryFlushPlanResolver, p as MemoryPromptSectionBuilder, r as MemoryCorpusSupplement, s as MemoryPluginCapability } from "./memory-state-CSqCMoFA.js";
import { Ft as PluginNextTurnInjection, It as PluginNextTurnInjectionEnqueueResult, Jt as PluginConversationBindingRequestResult, Kt as PluginConversationBinding, Rt as PluginJsonValue, Xt as PluginConversationBindingResolvedEvent, et as PluginHookName, nn as PluginHookBeforeAgentStartResult, q as PluginHookHandlerMap, qt as PluginConversationBindingRequestParams, vt as PluginHookToolInputKind, yt as PluginHookToolKind } from "./hook-types-BKz-S4lu.js";
import { Ao as PluginRuntimeLifecycleRegistration, Bo as PluginSessionTurnScheduleParams, Do as PluginControlUiDescriptor, Eo as PluginAgentEventSubscriptionRegistration, Fo as PluginSessionAttachmentResult, Go as OperatorScope, Ho as PluginSessionTurnUnscheduleByTagResult, Lo as PluginSessionExtensionRegistration, Mo as PluginSessionActionRegistration, Oo as PluginRunContextGetParams, Po as PluginSessionAttachmentParams, Ro as PluginSessionSchedulerJobHandle, To as PluginAgentEventEmitResult, Uo as PluginToolMetadataRegistration, Vo as PluginSessionTurnUnscheduleByTagParams, Wo as PluginTrustedToolPolicyRegistration, ko as PluginRunContextPatch, wo as PluginAgentEventEmitParams, zo as PluginSessionSchedulerJobRegistration } from "./index-CaLNQFzV.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
import { n as GatewayRequestHandler } from "./types-BMFYBAxt.js";
import { r as InternalHookHandler } from "./internal-hook-types-BwvTZGLB.js";
import { a as DiagnosticEventPayload, i as DiagnosticEventMetadata, jt as TalkTransport, r as DiagnosticEventInput } from "./diagnostic-events-C_Kyi8bL.js";
import { t as ProviderUsageSnapshot } from "./provider-usage.types-BGbkzahX.js";
import { n as PluginRuntime } from "./types-DpjQFFwi.js";
import { Duplex } from "node:stream";
import { TSchema } from "typebox";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { IncomingMessage, ServerResponse } from "node:http";
import { Command } from "commander";
import { AgentMessage, AgentTool, AgentToolResult, StreamFn } from "@earendil-works/pi-agent-core";

//#region src/plugins/compaction-provider.d.ts
/**
 * Compaction provider registry — process-global singleton.
 *
 * Plugins implement the CompactionProvider interface and register via
 * `registerCompactionProvider()`. The compaction safeguard checks this
 * registry before falling back to the built-in `summarizeInStages()`.
 */
/**
 * A pluggable compaction provider that can replace the built-in
 * summarizeInStages pipeline.
 */
type CompactionProviderSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};
interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionProviderSummarizationInstructions; /** Summary from a prior compaction round, if re-compacting. */
    previousSummary?: string;
  }): Promise<string>;
}
//#endregion
//#region src/memory-host-sdk/host/embedding-inputs.d.ts
type EmbeddingInputTextPart = {
  type: "text";
  text: string;
};
type EmbeddingInputInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};
type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;
type EmbeddingInput = {
  text: string;
  parts?: EmbeddingInputPart[];
};
//#endregion
//#region src/plugins/memory-embedding-providers.d.ts
type MemoryEmbeddingBatchChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};
type MemoryEmbeddingBatchOptions = {
  agentId: string;
  chunks: MemoryEmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};
type MemoryEmbeddingProviderCallOptions = {
  signal?: AbortSignal;
};
type MemoryEmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  inlineQueryTimeoutMs?: number;
  inlineBatchTimeoutMs?: number;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};
type MemoryEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: MemoryEmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (texts: string[], options?: MemoryEmbeddingProviderCallOptions) => Promise<number[][]>;
  embedBatchInputs?: (inputs: EmbeddingInput[], options?: MemoryEmbeddingProviderCallOptions) => Promise<number[][]>;
  close?: () => Promise<void> | void;
};
type MemoryEmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
  fallback?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  outputDimensionality?: number;
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY" | "CLASSIFICATION" | "CLUSTERING" | "QUESTION_ANSWERING" | "FACT_VERIFICATION";
};
type MemoryEmbeddingProviderCreateResult = {
  provider: MemoryEmbeddingProvider | null;
  runtime?: MemoryEmbeddingProviderRuntime;
};
type MemoryEmbeddingProviderAdapter = {
  id: string;
  defaultModel?: string;
  transport?: "local" | "remote";
  authProviderId?: string;
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: {
    model: string;
  }) => boolean;
  create: (options: MemoryEmbeddingProviderCreateOptions) => Promise<MemoryEmbeddingProviderCreateResult>;
  formatSetupError?: (err: unknown) => string;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};
type RegisteredMemoryEmbeddingProvider = {
  adapter: MemoryEmbeddingProviderAdapter;
  ownerPluginId?: string;
};
declare function registerMemoryEmbeddingProvider(adapter: MemoryEmbeddingProviderAdapter, options?: {
  ownerPluginId?: string;
}): void;
declare function listRegisteredMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[];
declare function clearMemoryEmbeddingProviders(): void;
//#endregion
//#region src/agents/pi-embedded-runner/runtime.d.ts
type EmbeddedAgentRuntime = "pi" | "auto" | (string & {});
declare function resolveEmbeddedAgentRuntime(env?: NodeJS.ProcessEnv): EmbeddedAgentRuntime;
//#endregion
//#region src/tasks/agent-harness-task-runtime-scope.d.ts
type AgentHarnessTaskRuntimeScope = {
  readonly requesterSessionKey: string;
  readonly requesterOrigin?: DeliveryContext;
};
//#endregion
//#region src/agents/pi-tools.before-tool-call.d.ts
type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
};
type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;
type HookContext = {
  agentId?: string;
  config?: OpenClawConfig; /** Tool execution cwd for host-derived path facts. */
  cwd?: string;
  sessionKey?: string; /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};
type HookBlockedKind = "veto" | "failure";
type HookBlockedReason = "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
type HookOutcome = {
  blocked: true;
  kind?: HookBlockedKind;
  deniedReason?: HookBlockedReason;
  reason: string;
  params?: unknown;
} | {
  blocked: false;
  params: unknown;
};
declare function hasBeforeToolCallPolicy(): boolean;
declare function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolKind?: PluginHookToolKind;
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  approvalMode?: "request" | "report";
}): Promise<HookOutcome>;
declare function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, ctx?: HookContext, options?: {
  emitDiagnostics?: boolean;
}): AnyAgentTool;
declare function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean;
declare function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void;
//#endregion
//#region src/agents/runtime-plan/types.d.ts
type AgentRuntimeTransport = "sse" | "websocket" | "auto";
type AgentRuntimeThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
type AgentRuntimePromptMode = "full" | "minimal" | "none";
type AgentRuntimePromptTrigger = "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
type AgentRuntimeFailoverReason = "auth" | "auth_permanent" | "format" | "rate_limit" | "overloaded" | "billing" | "server_error" | "timeout" | "model_not_found" | "session_expired" | "empty_response" | "no_error_details" | "unclassified" | "unknown";
type AgentRuntimeConfig = unknown;
type AgentRuntimeModel = {
  id?: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: readonly string[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  contextTokens?: number;
  compat?: unknown;
};
type AgentRuntimeTextReplacement = {
  from: string | RegExp;
  to: string;
};
type AgentRuntimeTextTransforms = {
  input?: AgentRuntimeTextReplacement[];
  output?: AgentRuntimeTextReplacement[];
};
type AgentRuntimeProviderHandle = {
  provider: string;
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
};
type AgentRuntimeInteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";
/** Portable action control exposed to agent runtime reply payloads. */
type AgentRuntimeMessagePresentationButton = {
  /** User-visible button label. */label: string; /** Callback command or opaque value sent when pressed. */
  value?: string; /** External URL opened by the button. */
  url?: string; /** Channel-native web app URL for renderers that support embedded web apps. */
  webApp?: {
    url: string;
  }; /** Higher values are kept first when channel action limits require dropping controls. */
  priority?: number; /** Disabled action hint; channels without disabled-state support render fallback text. */
  disabled?: boolean; /** Optional visual style hint for renderers that support styled actions. */
  style?: AgentRuntimeInteractiveButtonStyle;
};
/** Portable select/menu option exposed to agent runtime reply payloads. */
type AgentRuntimeMessagePresentationOption = {
  /** User-visible option label. */label: string; /** Callback command or opaque value sent when selected. */
  value: string;
};
/**
 * @deprecated Use AgentRuntimeMessagePresentationButton.
 */
type AgentRuntimeInteractiveReplyButton = AgentRuntimeMessagePresentationButton;
/**
 * @deprecated Use AgentRuntimeMessagePresentationOption.
 */
type AgentRuntimeInteractiveReplyOption = AgentRuntimeMessagePresentationOption;
/**
 * @deprecated Use AgentRuntimeMessagePresentationBlock.
 */
type AgentRuntimeInteractiveReplyBlock = {
  type: "text";
  text: string;
} | {
  type: "buttons";
  buttons: AgentRuntimeInteractiveReplyButton[];
} | {
  type: "select";
  placeholder?: string;
  options: AgentRuntimeInteractiveReplyOption[];
};
/**
 * @deprecated Use AgentRuntimeMessagePresentation.
 */
type AgentRuntimeInteractiveReply = {
  blocks: AgentRuntimeInteractiveReplyBlock[];
};
type AgentRuntimeMessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";
type AgentRuntimeMessagePresentationBlock = {
  type: "text";
  text: string;
} | {
  type: "context";
  text: string;
} | {
  type: "divider";
} | {
  type: "buttons";
  buttons: AgentRuntimeMessagePresentationButton[];
} | {
  type: "select";
  placeholder?: string;
  options: AgentRuntimeMessagePresentationOption[];
};
type AgentRuntimeMessagePresentation = {
  /** Optional short heading rendered before blocks when supported. */title?: string; /** Optional severity/status tone for renderers that support toned presentations. */
  tone?: AgentRuntimeMessagePresentationTone; /** Ordered portable blocks rendered or downgraded by channel adapters. */
  blocks: AgentRuntimeMessagePresentationBlock[];
};
type AgentRuntimeReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};
type AgentRuntimeReplyPayloadDelivery = {
  pin?: boolean | AgentRuntimeReplyPayloadDeliveryPin;
};
type AgentRuntimeReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  presentation?: AgentRuntimeMessagePresentation;
  delivery?: AgentRuntimeReplyPayloadDelivery;
  /**
   * @deprecated Use presentation.
   */
  interactive?: AgentRuntimeInteractiveReply;
  btw?: {
    question: string;
  };
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  spokenText?: string;
  ttsSupplement?: {
    spokenText: string;
    visibleTextAlreadyDelivered?: boolean;
  };
  isError?: boolean;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  isFallbackNotice?: boolean;
  isStatusNotice?: boolean;
  channelData?: Record<string, unknown>;
};
type AgentRuntimeSystemPromptSectionId = "interaction_style" | "tool_call_style" | "execution_bias";
type AgentRuntimeSystemPromptContribution = {
  stablePrefix?: string;
  dynamicSuffix?: string;
  sectionOverrides?: Partial<Record<AgentRuntimeSystemPromptSectionId, string>>;
};
type AgentRuntimeSystemPromptContributionContext = {
  config?: AgentRuntimeConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  promptMode: AgentRuntimePromptMode;
  runtimeChannel?: string;
  runtimeCapabilities?: string[];
  agentId?: string;
  trigger?: AgentRuntimePromptTrigger;
};
type AgentRuntimeFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};
type AgentRuntimeToolCallIdMode = "strict" | "strict9";
type AgentRuntimeTranscriptPolicy = {
  sanitizeMode: "full" | "images-only";
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: AgentRuntimeToolCallIdMode;
  preserveNativeAnthropicToolUseIds: boolean;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  sanitizeThinkingSignatures: boolean;
  dropThinkingBlocks: boolean;
  dropReasoningFromHistory?: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};
type AgentRuntimeOutcomeClassification = {
  message: string;
  reason?: AgentRuntimeFailoverReason;
  status?: number;
  code?: string;
  rawError?: string;
} | {
  error: unknown;
} | null | undefined;
type AgentRuntimeOutcomeClassifier = (params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}) => AgentRuntimeOutcomeClassification;
type AgentRuntimeResolvedRef = {
  provider: string;
  modelId: string;
  modelApi?: string;
  harnessId?: string;
  transport?: AgentRuntimeTransport;
};
type AgentRuntimeAuthPlan = {
  providerForAuth: string;
  authProfileProviderForAuth: string;
  harnessAuthProvider?: string;
  forwardedAuthProfileId?: string;
  forwardedAuthProfileCandidateIds?: string[];
};
type AgentRuntimePromptPlan = {
  provider: string;
  modelId: string;
  textTransforms?: AgentRuntimeTextTransforms;
  resolveSystemPromptContribution(context: AgentRuntimeSystemPromptContributionContext): AgentRuntimeSystemPromptContribution | undefined;
  transformSystemPrompt(context: AgentRuntimeSystemPromptContributionContext & {
    systemPrompt: string;
  }): string;
};
type AgentRuntimePreparedMetadataSnapshot = object;
type PreparedOpenClawToolPlanning = {
  metadataSnapshot?: AgentRuntimePreparedMetadataSnapshot;
  loadMetadataSnapshot?: () => AgentRuntimePreparedMetadataSnapshot;
};
type AgentRuntimeToolPlan = {
  preparedPlanning?: PreparedOpenClawToolPlanning;
  normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(tools: AgentTool<TSchemaType, TResult>[], params?: {
    workspaceDir?: string;
    modelApi?: string;
    model?: AgentRuntimeModel;
  }): AgentTool<TSchemaType, TResult>[];
  logDiagnostics(tools: AgentTool[], params?: {
    workspaceDir?: string;
    modelApi?: string;
    model?: AgentRuntimeModel;
  }): void;
};
type AgentRuntimeDeliveryPlan = {
  isSilentPayload(payload: Pick<AgentRuntimeReplyPayload, "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData">): boolean;
  resolveFollowupRoute(params: {
    payload: AgentRuntimeReplyPayload;
    originatingChannel?: string;
    originatingTo?: string;
    originRoutable: boolean;
    dispatcherAvailable: boolean;
  }): AgentRuntimeFollowupFallbackRouteResult | undefined;
};
type AgentRuntimeOutcomePlan = {
  classifyRunResult: AgentRuntimeOutcomeClassifier;
};
type AgentRuntimeTransportPlan = {
  extraParams: Record<string, unknown>;
  resolveExtraParams(params?: {
    extraParamsOverride?: Record<string, unknown>;
    thinkingLevel?: AgentRuntimeThinkLevel;
    agentId?: string;
    workspaceDir?: string;
    model?: AgentRuntimeModel;
    resolvedTransport?: AgentRuntimeTransport;
  }): Record<string, unknown>;
};
type AgentRuntimePlan = {
  resolvedRef: AgentRuntimeResolvedRef;
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
  auth: AgentRuntimeAuthPlan;
  prompt: AgentRuntimePromptPlan;
  tools: AgentRuntimeToolPlan;
  transcript: {
    policy: AgentRuntimeTranscriptPolicy;
    resolvePolicy(params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: AgentRuntimeModel;
    }): AgentRuntimeTranscriptPolicy;
  };
  delivery: AgentRuntimeDeliveryPlan;
  outcome: AgentRuntimeOutcomePlan;
  transport: AgentRuntimeTransportPlan;
  observability: {
    resolvedRef: string;
    provider: string;
    modelId: string;
    modelApi?: string;
    harnessId?: string;
    authProfileId?: string;
    transport?: AgentRuntimeTransport;
  };
};
type BuildAgentRuntimePlanParams = {
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  model?: AgentRuntimeModel;
  modelApi?: string | null;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
  authProfileProvider?: string;
  authProfileMode?: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileCandidateIds?: string[];
  agentId?: string;
  thinkingLevel?: AgentRuntimeThinkLevel;
  extraParamsOverride?: Record<string, unknown>;
  resolvedTransport?: AgentRuntimeTransport;
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
};
//#endregion
//#region src/agents/tool-mutation.d.ts
type FileTarget = {
  path?: string;
  oldpath?: string;
};
//#endregion
//#region src/agents/tool-error-summary.d.ts
type ToolErrorSummary = {
  toolName: string;
  meta?: string;
  errorCode?: string;
  error?: string;
  timedOut?: boolean;
  middlewareError?: boolean;
  mutatingAction?: boolean;
  actionFingerprint?: string;
  fileTarget?: FileTarget;
};
//#endregion
//#region src/agents/usage.d.ts
type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoningTokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  cached_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  prompt_n?: number;
  predicted_n?: number;
  timings?: {
    prompt_n?: number;
    predicted_n?: number;
  };
};
type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  total?: number;
};
declare function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined;
//#endregion
//#region src/agents/pi-embedded-runner/replay-state.d.ts
type EmbeddedRunReplayState = {
  replayInvalid: boolean;
  hadPotentialSideEffects: boolean;
};
type EmbeddedRunReplayMetadata = {
  hadPotentialSideEffects: boolean;
  replaySafe: boolean;
};
//#endregion
//#region src/agents/pi-embedded-runner/run/preemptive-compaction.types.d.ts
type PreemptiveCompactionRoute = "fits" | "compact_only" | "truncate_tool_results_only" | "compact_then_truncate";
//#endregion
//#region src/agents/pi-embedded-runner/run/types.d.ts
type EmbeddedRunAttemptBase = Omit<RunEmbeddedPiAgentParams, "provider" | "model" | "authProfileId" | "authProfileIdSource" | "thinkLevel" | "lane" | "enqueue">;
type EmbeddedRunContextWindowInfo = {
  tokens: number;
  referenceTokens?: number;
  source: "model" | "modelsConfig" | "agentContextTokens" | "default";
};
type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  initialReplayState?: EmbeddedRunReplayState; /** Pluggable context engine for ingest/assemble/compact lifecycle. */
  contextEngine?: ContextEngine; /** Resolved model context window in tokens for assemble/compact budgeting. */
  contextTokenBudget?: number; /** Source metadata for the resolved model context budget. */
  contextWindowInfo?: EmbeddedRunContextWindowInfo; /** Resolved API key for this run when runtime auth did not replace it. */
  resolvedApiKey?: string; /** Auth profile resolved for this attempt's provider/model call. */
  authProfileId?: string; /** Source for the resolved auth profile (user-locked or automatic). */
  authProfileIdSource?: "auto" | "user";
  provider: string;
  modelId: string; /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string; /** OpenClaw-owned runtime policy prepared by the orchestrator for this attempt. */
  runtimePlan?: AgentRuntimePlan; /** Host-issued scope for harnesses that mirror native child runs into task state. */
  agentHarnessTaskRuntimeScope?: AgentHarnessTaskRuntimeScope; /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  model: Model<Api>;
  authStorage: AuthStorage; /** Auth profile store already resolved during startup for this attempt. */
  authProfileStore: AuthProfileStore;
  /**
   * Full auth profile store for OpenClaw tool availability.
   * Plugin-owned harnesses may scope `authProfileStore` to model transport credentials.
   */
  toolAuthProfileStore?: AuthProfileStore;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
};
type EmbeddedRunAttemptResult = {
  aborted: boolean; /** True when the abort originated from the caller-provided abortSignal. */
  externalAbort: boolean;
  timedOut: boolean; /** True when the no-response LLM idle watchdog caused the timeout. */
  idleTimedOut: boolean; /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean; /** Optional because this type is re-exported as `AgentHarnessAttemptResult`. */
  timedOutDuringToolExecution?: boolean;
  promptError: unknown;
  /**
   * Identifies which phase produced the promptError.
   * - "prompt": the LLM call itself failed and may be eligible for retry/fallback.
   * - "compaction": the prompt succeeded, but waiting for compaction/retry teardown was aborted;
   *   this must not be retried as a fresh prompt or the same tool turn can replay.
   * - "precheck": pre-prompt overflow recovery intentionally short-circuited the prompt so the
   *   outer run loop can recover via compaction/truncation before any model call is made.
   * - "hook:before_agent_run": a lifecycle hook blocked the run before the prompt was sent.
   * - null: no promptError.
   */
  promptErrorSource: "prompt" | "compaction" | "precheck" | "hook:before_agent_run" | null;
  preflightRecovery?: {
    route: Exclude<PreemptiveCompactionRoute, "fits">;
    source?: "mid-turn";
    handled: true;
    truncatedCount?: number;
  } | {
    route: Exclude<PreemptiveCompactionRoute, "fits">;
    source?: "mid-turn";
    handled?: false;
  };
  sessionIdUsed: string;
  sessionFileUsed?: string;
  diagnosticTrace?: DiagnosticTraceContext;
  agentHarnessId?: string;
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  promptTimeoutOutcome?: {
    message?: string;
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
  };
  codexAppServerFailure?: {
    kind: "client_closed_before_turn_completed" | "turn_completion_idle_timeout";
    transport: "stdio" | "websocket";
    threadId?: string;
    turnId?: string;
    replaySafe: boolean;
    replayBlockedReason?: "assistant_output" | "tool_activity" | "potential_side_effect" | "active_item";
  };
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  systemPromptReport?: SessionSystemPromptReport;
  finalPromptText?: string;
  messagesSnapshot: AgentMessage[];
  assistantTexts: string[];
  toolMetas: Array<{
    toolName: string;
    meta?: string;
  }>;
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  lastAssistant: AssistantMessage | undefined;
  currentAttemptAssistant?: AssistantMessage | undefined;
  lastToolError?: ToolErrorSummary;
  didSendViaMessagingTool: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  promptCache?: ContextEnginePromptCacheInfo;
  compactionCount?: number;
  compactionTokensAfter?: number;
  /**
   * Client tool calls detected during this attempt (OpenResponses hosted
   * tools), in the order the underlying LLM emitted them. Field is
   * `undefined` when no client tools were called so existing truthiness
   * checks across the runner pipeline (`attempt.clientToolCalls ? ...`)
   * keep their meaning. When set, the array always has at least one entry.
   */
  clientToolCalls?: Array<{
    name: string;
    params: Record<string, unknown>;
  }>; /** True when sessions_yield tool was called during this attempt. */
  yieldDetected?: boolean;
  replayMetadata: EmbeddedRunReplayMetadata;
  itemLifecycle: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
  setTerminalLifecycleMeta?: (meta: {
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    stopReason?: string;
    yielded?: boolean;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
  }) => void;
};
//#endregion
//#region src/agents/pi-embedded-runner/compact.types.d.ts
type CompactEmbeddedPiSessionParams = {
  sessionId: string;
  runId?: string;
  sessionKey?: string; /** Session key used only for runtime policy/sandbox resolution. Defaults to sessionKey. */
  sandboxSessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number; /** Trusted sender id from inbound context for scoped message-tool discovery. */
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  authProfileId?: string; /** Group id for channel-level tool policy resolution. */
  groupId?: string | null; /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null; /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null; /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  sessionFile: string; /** Optional caller-observed live prompt tokens used for compaction diagnostics. */
  currentTokenCount?: number;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  provider?: string;
  model?: string; /** Effective model fallback chain for this session attempt. Undefined uses config defaults. */
  modelFallbacksOverride?: string[]; /** Optional caller-resolved context engine for harness-owned compaction. */
  contextEngine?: ContextEngine; /** Optional caller-resolved token budget for harness-owned compaction. */
  contextTokenBudget?: number; /** Optional caller-resolved runtime context for harness-owned context-engine compaction. */
  contextEngineRuntimeContext?: ContextEngineRuntimeContext; /** Session-pinned embedded harness id. Prevents compaction hot-switching. */
  agentHarnessId?: string; /** OpenClaw-owned runtime policy prepared for this compaction path. */
  runtimePlan?: AgentRuntimePlan;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  customInstructions?: string;
  tokenBudget?: number;
  force?: boolean;
  trigger?: "budget" | "overflow" | "manual";
  diagId?: string;
  attempt?: number;
  maxAttempts?: number;
  lane?: string;
  enqueue?: CommandQueueEnqueueFn;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  ownerNumbers?: string[];
  abortSignal?: AbortSignal;
  onCompactionHookMessages?: (payload: {
    phase: "before" | "after";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>; /** Allow runtime plugins for this compaction to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
};
//#endregion
//#region src/agents/harness/types.d.ts
type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  requestedRuntime: EmbeddedAgentRuntime;
};
type AgentHarnessSupport = {
  supported: true;
  priority?: number;
  reason?: string;
} | {
  supported: false;
  reason?: string;
};
type AgentHarnessAttemptParams = EmbeddedRunAttemptParams;
type AgentHarnessAttemptResult = EmbeddedRunAttemptResult;
type AgentHarnessSideQuestionParams = {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  runtimeModel?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  question: string;
  sessionEntry: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel: ReasoningLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: GetReplyOptions;
  isNewSession: boolean;
  sessionId: string;
  sessionFile: string;
  agentId?: string;
  workspaceDir?: string;
  messageChannel?: string;
  messageProvider?: string;
  currentChannelId?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};
type AgentHarnessSideQuestionResult = {
  text: string;
};
type AgentHarnessCompactParams = CompactEmbeddedPiSessionParams;
type AgentHarnessCompactResult = EmbeddedPiCompactResult;
type AgentHarnessResetParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
};
type AgentHarnessResultClassification = "ok" | NonNullable<AgentHarnessAttemptResult["agentHarnessResultClassification"]>;
type AgentHarnessDeliveryDefaults = {
  /**
   * @deprecated Prefer `messages.visibleReplies` / `messages.groupChat.visibleReplies`
   * config. Kept for existing harness plugins.
   */
  sourceVisibleReplies?: "automatic" | "message_tool";
};
type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  /**
   * Context-engine host capabilities provided by this harness during agent
   * runs. Harnesses that omit this are unsupported for engines that declare
   * host requirements.
   */
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  deliveryDefaults?: AgentHarnessDeliveryDefaults;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
  runSideQuestion?(params: AgentHarnessSideQuestionParams): Promise<AgentHarnessSideQuestionResult>;
  classify?(result: AgentHarnessAttemptResult, ctx: AgentHarnessAttemptParams): AgentHarnessResultClassification | undefined;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};
//#endregion
//#region src/agents/system-prompt-contribution.d.ts
type ProviderSystemPromptSectionId = "interaction_style" | "tool_call_style" | "execution_bias";
type ProviderSystemPromptContribution = {
  /**
   * Cache-stable provider guidance inserted above the system-prompt cache boundary.
   *
   * Use this for static provider/model-family instructions that should preserve
   * KV cache reuse across turns.
   */
  stablePrefix?: string;
  /**
   * Provider guidance inserted below the cache boundary.
   *
   * Use this only for genuinely dynamic text that is expected to vary across
   * runs or sessions.
   */
  dynamicSuffix?: string;
  /**
   * Whole-section replacements for selected core prompt sections.
   *
   * Values should contain the complete rendered section, including any desired
   * heading such as `## Tool Call Style`.
   */
  sectionOverrides?: Partial<Record<ProviderSystemPromptSectionId, string>>;
};
//#endregion
//#region src/realtime-transcription/provider-types.d.ts
type RealtimeTranscriptionProviderId = string;
type RealtimeTranscriptionProviderConfig = Record<string, unknown>;
type RealtimeTranscriptionProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeTranscriptionProviderConfig;
};
type RealtimeTranscriptionProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};
type RealtimeTranscriptionSessionCallbacks = {
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
};
type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};
type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
  isConnected(): boolean;
};
//#endregion
//#region src/security/audit.types.d.ts
type SecurityAuditSeverity = "info" | "warn" | "critical";
type SecurityAuditFinding = {
  checkId: string;
  severity: SecurityAuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
};
//#endregion
//#region src/talk/provider-types.d.ts
type RealtimeVoiceProviderId = string;
type RealtimeVoiceRole = "user" | "assistant";
type RealtimeVoiceCloseReason = "completed" | "error";
type RealtimeVoiceAudioFormat = {
  encoding: "g711_ulaw";
  sampleRateHz: 8000;
  channels: 1;
} | {
  encoding: "pcm16";
  sampleRateHz: 24000;
  channels: 1;
};
declare const REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ: RealtimeVoiceAudioFormat;
declare const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat;
type RealtimeVoiceTool = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};
type RealtimeVoiceToolCallEvent = {
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
};
type RealtimeVoiceToolResultOptions = {
  /**
   * Submit the tool result without prompting the realtime provider to generate a new assistant
   * response. Use when another channel has already delivered the user-visible answer.
   */
  suppressResponse?: boolean;
  willContinue?: boolean;
};
type RealtimeVoiceBridgeEvent = {
  direction: "client" | "server";
  type: string;
  detail?: string;
};
type RealtimeVoiceBridgeCallbacks = {
  onAudio: (audio: Buffer) => void;
  onClearAudio: () => void;
  onMark?: (markName: string) => void;
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};
type RealtimeVoiceProviderConfig = Record<string, unknown>;
type RealtimeVoiceProviderCapabilities = {
  transports: TalkTransport[];
  inputAudioFormats: RealtimeVoiceAudioFormat[];
  outputAudioFormats: RealtimeVoiceAudioFormat[];
  supportsBrowserSession?: boolean;
  supportsBargeIn?: boolean;
  supportsToolCalls?: boolean;
  supportsVideoFrames?: boolean;
  supportsSessionResumption?: boolean;
};
type RealtimeVoiceProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
};
type RealtimeVoiceProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
};
type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  instructions?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  tools?: RealtimeVoiceTool[];
};
type RealtimeVoiceBrowserSessionCreateRequest = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};
type RealtimeVoiceBrowserAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};
type RealtimeVoiceBrowserWebRtcSdpSession = {
  provider: RealtimeVoiceProviderId;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
};
type RealtimeVoiceBrowserJsonPcmWebSocketSession = {
  provider: RealtimeVoiceProviderId;
  transport: "provider-websocket";
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeVoiceBrowserAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
};
type RealtimeVoiceBrowserGatewayRelaySession = {
  provider: RealtimeVoiceProviderId;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
};
type RealtimeVoiceBrowserManagedRoomSession = {
  provider: RealtimeVoiceProviderId;
  transport: "managed-room";
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};
type RealtimeVoiceBrowserSession = RealtimeVoiceBrowserWebRtcSdpSession | RealtimeVoiceBrowserJsonPcmWebSocketSession | RealtimeVoiceBrowserGatewayRelaySession | RealtimeVoiceBrowserManagedRoomSession;
type RealtimeVoiceBridge = {
  supportsToolResultContinuation?: boolean;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  setMediaTimestamp(ts: number): void;
  sendUserMessage?(text: string): void;
  triggerGreeting?(instructions?: string): void;
  handleBargeIn?(options?: RealtimeVoiceBargeInOptions): void;
  submitToolResult(callId: string, result: unknown, options?: RealtimeVoiceToolResultOptions): void;
  acknowledgeMark(): void;
  close(): void;
  isConnected(): boolean;
};
type RealtimeVoiceBargeInOptions = {
  /**
   * The caller has already confirmed assistant audio is still playing in its output sink.
   * This lets providers interrupt output even when the sink cannot provide real playback marks.
   */
  audioPlaybackActive?: boolean; /** Interrupt even when normal barge-in audio-duration guards would treat the event as echo. */
  force?: boolean;
};
//#endregion
//#region src/plugins/agent-tool-result-middleware-types.d.ts
type OpenClawAgentToolResult<TResult = unknown> = AgentToolResult<TResult>;
type AgentToolResultMiddlewareRuntime = "pi" | "codex";
/** @deprecated Use AgentToolResultMiddlewareRuntime. */
type AgentToolResultMiddlewareHarness = AgentToolResultMiddlewareRuntime | "codex-app-server";
type AgentToolResultMiddlewareEvent = {
  threadId?: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  cwd?: string;
  isError?: boolean;
  result: OpenClawAgentToolResult;
};
type AgentToolResultMiddlewareContext = {
  runtime: AgentToolResultMiddlewareRuntime; /** @deprecated Use runtime. */
  harness?: AgentToolResultMiddlewareRuntime;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};
type AgentToolResultMiddlewareResult = {
  result: OpenClawAgentToolResult;
};
type AgentToolResultMiddleware = (event: AgentToolResultMiddlewareEvent, ctx: AgentToolResultMiddlewareContext) => Promise<AgentToolResultMiddlewareResult | void> | AgentToolResultMiddlewareResult | void;
type AgentToolResultMiddlewareOptions = {
  runtimes?: AgentToolResultMiddlewareRuntime[]; /** @deprecated Use runtimes. */
  harnesses?: AgentToolResultMiddlewareHarness[];
};
//#endregion
//#region src/plugins/cli-backend.types.d.ts
type PluginTextReplacement = {
  from: string | RegExp;
  to: string;
};
type PluginTextTransforms = {
  /** Rewrites applied to outbound prompt text before provider/CLI transport. */input?: PluginTextReplacement[]; /** Rewrites applied to inbound assistant text before OpenClaw consumes it. */
  output?: PluginTextReplacement[];
};
type CliBundleMcpMode = "claude-config-file" | "codex-config-overrides" | "gemini-system-settings";
type CliBackendPrepareExecutionContext = {
  config?: OpenClawConfig;
  workspaceDir: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  authProfileId?: string;
};
type CliBackendPreparedExecution = {
  env?: Record<string, string>;
  clearEnv?: string[];
  cleanup?: () => Promise<void>;
};
type CliBackendThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
type CliBackendResolveExecutionArgsContext = {
  config?: OpenClawConfig;
  workspaceDir: string;
  provider: string;
  modelId: string;
  authProfileId?: string;
  thinkingLevel?: CliBackendThinkingLevel;
  useResume: boolean;
  baseArgs: readonly string[];
};
type CliBackendResolveExecutionArgs = (ctx: CliBackendResolveExecutionArgsContext) => readonly string[] | null | undefined;
type CliBackendAuthEpochMode = "combined" | "profile-only";
type CliBackendNativeToolMode = "none" | "always-on";
type CliBackendNormalizeConfigContext = {
  config?: OpenClawConfig;
  backendId: string;
  agentId?: string;
};
/** Plugin-owned CLI backend defaults used by the text-only CLI runner. */
type CliBackendPlugin = {
  /** Provider id used in model refs, for example `claude-cli/opus`. */id: string; /** Default backend config before user overrides from `agents.defaults.cliBackends`. */
  config: CliBackendConfig;
  /**
   * Context-engine host capabilities provided by this backend when it is
   * driven through the generic CLI runner.
   */
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  /**
   * Optional live-smoke metadata owned by the backend plugin.
   *
   * Keep provider-specific test wiring here instead of scattering it across
   * Docker wrappers, docs, and gateway live tests.
   */
  liveTest?: {
    defaultModelRef?: string;
    defaultImageProbe?: boolean;
    defaultMcpProbe?: boolean;
    docker?: {
      npmPackage?: string;
      binaryName?: string;
    };
  };
  /**
   * Whether OpenClaw should inject bundle MCP config for this backend.
   *
   * Keep this opt-in. Only backends that explicitly consume OpenClaw's bundle
   * MCP bridge should enable it.
   */
  bundleMcp?: boolean;
  /**
   * Provider-owned bundle MCP integration strategy.
   *
   * Different CLIs wire MCP through different surfaces:
   * - Claude: `--strict-mcp-config --mcp-config`
   * - Codex: `-c mcp_servers=...`
   * - Gemini: system-level `settings.json`
   */
  bundleMcpMode?: CliBundleMcpMode;
  /**
   * Optional config normalizer applied after user overrides merge.
   *
   * Use this for backend-specific compatibility rewrites when old config
   * shapes need to stay working.
   */
  normalizeConfig?: (config: CliBackendConfig, context?: CliBackendNormalizeConfigContext) => CliBackendConfig;
  /**
   * Backend-owned final system-prompt transform.
   *
   * Use this for tiny CLI-specific compatibility rewrites without replacing
   * the generic CLI runner or prompt builder.
   */
  transformSystemPrompt?: (ctx: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    modelDisplay: string;
    agentId?: string;
    systemPrompt: string;
  }) => string | null | undefined;
  /**
   * Backend-owned bidirectional text replacements.
   *
   * `input` applies to the system prompt and user prompt passed to the CLI.
   * `output` applies to parsed/streamed assistant text from the CLI.
   */
  textTransforms?: PluginTextTransforms;
  /**
   * Preferred auth-profile id when the caller did not explicitly lock one.
   *
   * Use this when the backend should consume a canonical OpenClaw auth profile
   * rather than ambient host auth by default.
   */
  defaultAuthProfileId?: string;
  /**
   * Session/auth epoch source policy.
   *
   * `combined` keeps the legacy "host credential + auth profile" fingerprint.
   * `profile-only` treats the selected OpenClaw auth profile as the sole auth
   * owner for session invalidation when one is present.
   */
  authEpochMode?: CliBackendAuthEpochMode;
  /**
   * Backend-owned execution bridge.
   *
   * Use this on async run paths when the backend needs a generated auth/config
   * bridge (for example a private CLI home directory) without teaching the core
   * runner about provider-specific file formats.
   */
  prepareExecution?: (ctx: CliBackendPrepareExecutionContext) => Promise<CliBackendPreparedExecution | null | undefined> | CliBackendPreparedExecution | null | undefined;
  /**
   * Backend-owned per-run argv rewrite.
   *
   * Use this for request-scoped CLI dialect flags that should not be modeled
   * as static config, such as mapping OpenClaw thinking levels to a backend's
   * native effort flag.
   */
  resolveExecutionArgs?: CliBackendResolveExecutionArgs;
  /**
   * Whether this CLI backend can expose native tools outside OpenClaw's tool
   * catalog. Backends that cannot provide a true no-tools mode must mark
   * themselves as `always-on` so callers that require disabled tools fail
   * closed instead of launching a native harness.
   */
  nativeToolMode?: CliBackendNativeToolMode;
};
//#endregion
//#region src/plugins/codex-app-server-extension-types.d.ts
type CodexAppServerToolResultEvent = {
  threadId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: AgentToolResult<unknown>;
};
type CodexAppServerExtensionContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};
type CodexAppServerToolResultHandlerResult = {
  result: AgentToolResult<unknown>;
};
type CodexAppServerExtensionRuntime = {
  on: (event: "tool_result", handler: (event: CodexAppServerToolResultEvent, ctx: CodexAppServerExtensionContext) => Promise<CodexAppServerToolResultHandlerResult | void> | CodexAppServerToolResultHandlerResult | void) => void;
};
type CodexAppServerExtensionFactory = (runtime: CodexAppServerExtensionRuntime) => Promise<void> | void;
//#endregion
//#region src/plugins/provider-config-context.types.d.ts
/**
 * Provider-owned config normalization for `models.providers.<id>` entries.
 *
 * Use this for provider-specific config cleanup that should stay with the
 * plugin rather than in core config-policy tables.
 */
type ProviderNormalizeConfigContext = {
  provider: string;
  providerConfig: ModelProviderConfig;
};
/**
 * Provider-owned env/config auth marker resolution for `models.providers`.
 *
 * Use this when a provider resolves auth from env vars that do not follow the
 * generic API-key conventions.
 */
type ProviderResolveConfigApiKeyContext = {
  provider: string;
  env: NodeJS.ProcessEnv;
};
/**
 * Provider-owned config-default application input.
 *
 * Use this when a provider needs to add global config defaults that depend on
 * provider auth mode or provider-specific model families.
 */
type ProviderApplyConfigDefaultsContext = {
  provider: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};
//#endregion
//#region src/plugins/provider-external-auth.types.d.ts
type ProviderResolveSyntheticAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
};
type ProviderSyntheticAuthResult = {
  apiKey: string;
  source: string;
  mode: Exclude<ModelProviderAuthMode, "aws-sdk">;
  expiresAt?: number;
};
type ProviderResolveExternalOAuthProfilesContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  store: AuthProfileStore;
};
type ProviderResolveExternalAuthProfilesContext = ProviderResolveExternalOAuthProfilesContext;
type ProviderExternalOAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};
type ProviderExternalAuthProfile = ProviderExternalOAuthProfile;
//#endregion
//#region src/plugins/provider-oauth-flow.d.ts
type OAuthPrompt = {
  message: string;
  placeholder?: string;
};
declare function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
  manualPromptMessage?: string;
}): {
  onAuth: (event: {
    url: string;
  }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
};
//#endregion
//#region src/plugins/provider-runtime-model.types.d.ts
/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
type ProviderRuntimeModel = Omit<Model<Api>, "compat"> & {
  compat?: ModelCompatConfig;
  contextTokens?: number;
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
};
//#endregion
//#region src/plugins/provider-thinking.types.d.ts
/**
 * Provider-owned thinking policy input.
 *
 * Used by shared `/think`, ACP controls, and directive parsing to ask a
 * provider whether a model supports special reasoning UX such as adaptive,
 * xhigh, max, or a binary on/off toggle.
 */
type ProviderThinkingPolicyContext = {
  provider: string;
  modelId: string;
};
/**
 * Provider-owned default thinking policy input.
 *
 * `reasoning` is the merged catalog hint for the selected model when one is
 * available. Providers can use it to keep "reasoning model => low" behavior
 * without re-reading the catalog themselves.
 */
type ProviderDefaultThinkingPolicyContext = ProviderThinkingPolicyContext & {
  reasoning?: boolean;
};
type ProviderThinkingLevelId = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
type ProviderThinkingLevel = {
  id: ProviderThinkingLevelId;
  /**
   * Optional display label. Use this when the stored value differs from the
   * provider-facing UX, for example binary providers storing `low` but showing
   * `on`.
   */
  label?: string;
  /**
   * Relative strength used when downgrading a stored level that the selected
   * model no longer supports.
   */
  rank?: number;
};
type ProviderThinkingProfile = {
  levels: ProviderThinkingLevel[] | ReadonlyArray<ProviderThinkingLevel>;
  defaultLevel?: ProviderThinkingLevelId | null;
  /**
   * Some bundled providers have model-specific thinking contracts that are more
   * current than cached generic catalog metadata. Keep this opt-in so
   * `reasoning: false` remains authoritative for ordinary catalog entries.
   */
  preserveWhenCatalogReasoningFalse?: boolean;
};
//#endregion
//#region src/plugins/types.d.ts
type ModelProviderRequestTransportOverrides = ModelProviderRequestTransportOverrides$1;
type ProviderAuthOptionBag = {
  token?: string;
  tokenProvider?: string;
  secretInputMode?: SecretInputMode;
  [key: string]: unknown;
};
/** Logger passed into plugin registration, services, and CLI surfaces. */
type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
type PluginConfigValidation = {
  ok: true;
  value?: unknown;
} | {
  ok: false;
  errors: string[];
};
/**
 * Config schema contract accepted by plugin manifests and runtime registration.
 *
 * Plugins can provide a Zod-like parser, a lightweight `validate(...)`
 * function, or both. `uiHints` and `jsonSchema` are optional extras for docs,
 * forms, and config UIs.
 */
type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{
        path: Array<string | number>;
        message: string;
      }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: JsonSchemaObject;
};
type ProviderAuthKind = "oauth" | "api_key" | "token" | "device_code" | "custom";
/** Standard result payload returned by provider auth methods. */
type ProviderAuthResult = {
  profiles: Array<{
    profileId: string;
    credential: AuthProfileCredential;
  }>;
  /**
   * Optional config patch to merge after credentials are written.
   *
   * Use this for provider-owned onboarding defaults such as
   * `models.providers.<id>` entries, default aliases, or agent model helpers.
   * The caller still persists auth-profile bindings separately.
   */
  configPatch?: Partial<OpenClawConfig>;
  defaultModel?: string;
  notes?: string[];
  /**
   * Opt in to replace `agents.defaults.models` wholesale with the patch map.
   * Default behavior merges the map so other providers' entries survive.
   * Set only from migrations that intentionally rename/remove model keys.
   */
  replaceDefaultModels?: boolean;
};
/** Interactive auth context passed to provider login/setup methods. */
type ProviderAuthContext = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  /**
   * Optional onboarding CLI options that triggered this auth flow.
   *
   * Present for setup/configure/auth-choice flows so provider methods can
   * honor preseeded flags like `--openai-api-key` or generic
   * `--token/--token-provider` pairs. Direct `models auth login` usually
   * leaves this undefined.
   */
  opts?: ProviderAuthOptionBag;
  /**
   * Onboarding secret persistence preference.
   *
   * Interactive wizard flows set this when the caller explicitly requested
   * plaintext or env/file/exec ref storage. Ad-hoc `models auth login` flows
   * usually leave it undefined.
   */
  secretInputMode?: SecretInputMode;
  /**
   * Whether the provider auth flow should offer the onboarding secret-storage
   * mode picker when `secretInputMode` is unset.
   *
   * This is true for onboarding/configure flows and false for direct
   * `models auth` commands, which should keep a tighter, provider-owned prompt
   * surface.
   */
  allowSecretRefPrompt?: boolean;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  oauth: {
    createVpsAwareHandlers: typeof createVpsAwareOAuthHandlers;
  };
};
type ProviderNonInteractiveApiKeyResult = {
  key: string;
  source: "profile" | "env" | "flag";
  envVarName?: string;
};
type ProviderResolveNonInteractiveApiKeyParams = {
  provider: string;
  flagValue?: string;
  flagName: `--${string}`;
  envVar: string;
  envVarName?: string;
  allowProfile?: boolean;
  required?: boolean;
};
type ProviderNonInteractiveApiKeyCredentialParams = {
  provider: string;
  resolved: ProviderNonInteractiveApiKeyResult;
  email?: string;
  metadata?: Record<string, string>;
};
type ProviderAuthMethodNonInteractiveContext = {
  authChoice: string;
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  opts: ProviderAuthOptionBag;
  runtime: RuntimeEnv;
  agentDir?: string;
  workspaceDir?: string;
  resolveApiKey: (params: ProviderResolveNonInteractiveApiKeyParams) => Promise<ProviderNonInteractiveApiKeyResult | null>;
  toApiKeyCredential: (params: ProviderNonInteractiveApiKeyCredentialParams) => ApiKeyCredential | null;
};
type ProviderAuthMethod = {
  id: string;
  label: string;
  hint?: string;
  kind: ProviderAuthKind;
  /**
   * Optional wizard/onboarding metadata for this specific auth method.
   *
   * Use this when one provider exposes multiple setup entries (for example API
   * key + OAuth, or region-specific login flows). OpenClaw uses this to expose
   * method-specific auth choices while keeping the provider id stable.
   */
  wizard?: ProviderPluginWizardSetup;
  run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
  runNonInteractive?: (ctx: ProviderAuthMethodNonInteractiveContext) => Promise<OpenClawConfig | null>;
};
type ProviderCatalogOrder = "simple" | "profile" | "paired" | "late";
type ProviderCatalogContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: (providerId?: string, options?: {
    oauthMarker?: string;
  }) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  };
};
type ProviderCatalogResult = {
  provider: ModelProviderConfig;
} | {
  providers: Record<string, ModelProviderConfig>;
} | null | undefined;
type ProviderPluginCatalog = {
  order?: ProviderCatalogOrder;
  run: (ctx: ProviderCatalogContext) => Promise<ProviderCatalogResult>;
};
type UnifiedModelCatalogProviderContext = ProviderCatalogContext & {
  signal?: AbortSignal;
  includeLive?: boolean;
  timeoutMs?: number;
};
type UnifiedModelCatalogProviderPlugin = {
  provider: string;
  kinds: readonly UnifiedModelCatalogKind[];
  staticCatalog?: (ctx: UnifiedModelCatalogProviderContext) => readonly UnifiedModelCatalogEntry[] | Promise<readonly UnifiedModelCatalogEntry[] | null | undefined> | null | undefined;
  liveCatalog?: (ctx: UnifiedModelCatalogProviderContext) => readonly UnifiedModelCatalogEntry[] | Promise<readonly UnifiedModelCatalogEntry[] | null | undefined> | null | undefined;
};
type ProviderRuntimeProviderConfig = {
  baseUrl?: string;
  api?: ModelProviderConfig["api"];
  models?: ModelProviderConfig["models"];
  headers?: unknown;
};
/**
 * Sync hook for provider-owned model ids that are not present in the local
 * registry/catalog yet.
 *
 * Use this for pass-through providers or provider-specific forward-compat
 * behavior. The hook should be cheap and side-effect free; async refreshes
 * belong in `prepareDynamicModel`.
 */
type ProviderResolveDynamicModelContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  providerConfig?: ProviderRuntimeProviderConfig;
};
/**
 * Optional async warm-up for dynamic model resolution.
 *
 * Called only from async model resolution paths, before retrying
 * `resolveDynamicModel`. This is the place to refresh caches or fetch provider
 * metadata over the network.
 */
type ProviderPrepareDynamicModelContext = ProviderResolveDynamicModelContext;
type ProviderPreferRuntimeResolvedModelContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
};
/**
 * Last-chance rewrite hook for provider-owned transport normalization.
 *
 * Runs after OpenClaw resolves an explicit/discovered/dynamic model and before
 * the embedded runner uses it. Typical uses: swap API ids, fix base URLs, or
 * patch provider-specific compat bits.
 */
type ProviderNormalizeResolvedModelContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};
/**
 * Provider-owned model-id normalization before config/runtime lookup.
 *
 * Use this for provider-specific alias cleanup that should stay with the
 * plugin rather than in core string tables.
 */
type ProviderNormalizeModelIdContext = {
  provider: string;
  modelId: string;
};
/**
 * Provider-owned transport normalization for arbitrary provider/model config.
 *
 * Use this when transport cleanup depends on API/baseUrl rather than the
 * owning provider id, for example custom providers that still target a
 * plugin-owned transport family.
 */
type ProviderNormalizeTransportContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  provider: string;
  api?: string | null;
  baseUrl?: string;
};
/**
 * Runtime auth input for providers that need an extra exchange step before
 * inference. The incoming `apiKey` is the raw credential resolved from auth
 * profiles/env/config. The returned value should be the actual token/key to use
 * for the request.
 */
type ProviderPrepareRuntimeAuthContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
  apiKey: string;
  authMode: string;
  profileId?: string;
};
/**
 * Result of `prepareRuntimeAuth`.
 *
 * `apiKey` is required and becomes the runtime credential stored in auth
 * storage. `baseUrl` is optional and lets providers like GitHub Copilot swap to
 * an entitlement-specific endpoint at request time. `expiresAt` enables generic
 * background refresh in long-running turns.
 */
type ProviderPreparedRuntimeAuth = {
  apiKey: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};
/**
 * Usage/billing auth input for providers that expose quota/usage endpoints.
 *
 * This hook is intentionally separate from `prepareRuntimeAuth`: usage
 * snapshots often need a different credential source than live inference
 * requests, and they run outside the embedded runner.
 *
 * The helper methods cover the common OpenClaw auth resolution paths:
 *
 * - `resolveApiKeyFromConfigAndStore`: env/config/plain token/api_key profiles
 * - `resolveOAuthToken`: oauth/token profiles resolved through the auth store,
 *   optionally for an explicit provider override
 *
 * Plugins can still do extra provider-specific work on top (for example parse a
 * token blob, read a legacy credential file, or pick between aliases).
 */
type ProviderResolveUsageAuthContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  resolveApiKeyFromConfigAndStore: (params?: {
    providerIds?: string[];
    envDirect?: Array<string | undefined>;
  }) => string | undefined;
  resolveOAuthToken: (params?: {
    provider?: string;
  }) => Promise<ProviderResolvedUsageAuth | null>;
};
/**
 * Result of `resolveUsageAuth`.
 *
 * `token` is the credential used for provider usage/billing endpoints.
 * `accountId` is optional provider-specific metadata used by some usage APIs.
 */
type ProviderResolvedUsageAuth = {
  token: string;
  accountId?: string;
};
/**
 * Usage/quota snapshot input for providers that own their usage endpoint
 * fetch/parsing behavior.
 *
 * This hook runs after `resolveUsageAuth` succeeds. Core still owns summary
 * fan-out, timeout wrapping, filtering, and formatting; the provider plugin
 * owns the provider-specific HTTP request + response normalization.
 */
type ProviderFetchUsageSnapshotContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  token: string;
  accountId?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
};
/**
 * Provider-owned auth-doctor hint input.
 *
 * Called when OAuth refresh fails and OpenClaw wants a provider-specific repair
 * hint to append to the generic re-auth message. Use this for legacy profile-id
 * migrations or other provider-owned auth-store cleanup guidance.
 */
type ProviderAuthDoctorHintContext = {
  config?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
};
/**
 * Provider-owned extra-param normalization before OpenClaw builds its generic
 * stream option wrapper.
 *
 * Use this to set provider defaults or rewrite provider-specific config keys
 * into the merged `extraParams` object. Return the full next extraParams object.
 */
type ProviderPrepareExtraParamsContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  extraParams?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
};
type ProviderExtraParamsForTransportContext = Omit<ProviderPrepareExtraParamsContext, "extraParams"> & {
  model?: ProviderRuntimeModel;
  transport?: "sse" | "websocket" | "auto";
  extraParams: Record<string, unknown>;
};
type ProviderExtraParamsForTransportResult = {
  patch?: Record<string, unknown> | null;
};
type ProviderResolvePromptOverlayContext = ProviderSystemPromptContributionContext & {
  baseOverlay?: ProviderSystemPromptContribution;
};
type ProviderFollowupFallbackRouteContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  payload: ReplyPayload;
  originatingChannel?: string;
  originatingTo?: string;
  originRoutable: boolean;
  dispatcherAvailable: boolean;
};
type ProviderFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};
type ProviderResolveAuthProfileIdContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  preferredProfileId?: string;
  lockedProfileId?: string;
  profileOrder: string[];
  authStore: AuthProfileStore;
};
type ProviderReplaySanitizeMode = "full" | "images-only";
type ProviderReplayToolCallIdMode = "strict" | "strict9";
type ProviderReasoningOutputMode = "native" | "tagged";
/**
 * @deprecated Legacy static provider capability bag.
 *
 * Core replay/runtime ownership now lives on explicit provider hooks such as
 * `buildReplayPolicy`, `normalizeToolSchemas`, and `wrapStreamFn`. OpenClaw no
 * longer reads this bag at runtime, but the field remains typed so existing
 * third-party plugins do not fail to compile immediately.
 */
type ProviderCapabilities = Record<string, unknown>;
/**
 * Provider-owned replay/compaction transcript policy.
 *
 * These values are consumed by shared history replay and compaction logic.
 * Return only the fields the provider wants to override; core fills the rest
 * with its default policy.
 */
type ProviderReplayPolicy = {
  sanitizeMode?: ProviderReplaySanitizeMode;
  sanitizeToolCallIds?: boolean;
  toolCallIdMode?: ProviderReplayToolCallIdMode;
  preserveNativeAnthropicToolUseIds?: boolean;
  preserveSignatures?: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  dropThinkingBlocks?: boolean;
  dropReasoningFromHistory?: boolean;
  repairToolUseResultPairing?: boolean;
  applyAssistantFirstOrderingFix?: boolean;
  validateGeminiTurns?: boolean;
  validateAnthropicTurns?: boolean;
  allowSyntheticToolResults?: boolean;
};
/**
 * Provider-owned replay/compaction policy input.
 *
 * Use this when transcript replay rules depend on provider/model transport
 * behavior and should stay with the provider plugin instead of core tables.
 */
type ProviderReplayPolicyContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  provider: string;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
};
type ProviderReplaySessionEntry = {
  customType: string;
  data?: unknown;
};
type ProviderReplaySessionState = {
  getCustomEntries(): ProviderReplaySessionEntry[];
  appendCustomEntry(customType: string, data: unknown): void;
};
/**
 * Provider-owned replay-history sanitization input.
 *
 * Runs after core applies generic transcript cleanup so plugins can make
 * provider-specific replay rewrites without owning the whole compaction flow.
 */
type ProviderSanitizeReplayHistoryContext = ProviderReplayPolicyContext & {
  sessionId: string;
  messages: AgentMessage[];
  allowedToolNames?: Iterable<string>;
  sessionState?: ProviderReplaySessionState;
};
/**
 * Provider-owned final replay-turn validation input.
 *
 * Use this for providers that require strict turn ordering or additional
 * replay-time transcript validation beyond generic sanitation.
 */
type ProviderValidateReplayTurnsContext = ProviderReplayPolicyContext & {
  sessionId?: string;
  messages: AgentMessage[];
  sessionState?: ProviderReplaySessionState;
};
/**
 * Provider-owned tool-schema normalization input.
 *
 * Runs before tool registration for replay/compaction/inference so providers
 * can rewrite schema keywords that their transport family does not support.
 */
type ProviderNormalizeToolSchemasContext = ProviderReplayPolicyContext & {
  tools: AnyAgentTool[];
};
type ProviderToolSchemaDiagnostic = {
  toolName: string;
  toolIndex?: number;
  violations: string[];
};
/**
 * Provider-owned reasoning output mode input.
 *
 * Use this when a provider requires a specific reasoning-output contract, such
 * as text tags instead of native structured reasoning fields.
 */
type ProviderReasoningOutputModeContext = ProviderReplayPolicyContext;
/**
 * Provider-owned transport creation.
 *
 * Use this when the provider needs to replace pi-ai's default transport with a
 * custom StreamFn (for example a native API transport that cannot be expressed
 * as a wrapper around `streamSimple`).
 */
type ProviderCreateStreamFnContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};
/**
 * Provider-owned stream wrapper hook after OpenClaw applies its generic
 * transport-independent wrappers.
 *
 * Use this for provider-specific payload/header/model mutations that still run
 * through the normal `pi-ai` stream path.
 */
type ProviderWrapStreamFnContext = ProviderPrepareExtraParamsContext & {
  model?: ProviderRuntimeModel;
  streamFn?: StreamFn;
};
/**
 * Provider-owned transport turn state.
 *
 * Use this for provider-native request headers or metadata that should stay
 * stable across retries while still being attached by generic core transports.
 */
type ProviderTransportTurnState = {
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
};
/**
 * Provider-owned request identity for transport turns.
 *
 * Use this when the provider exposes native request/session metadata that must
 * be attached by both HTTP and WebSocket transports.
 */
type ProviderResolveTransportTurnStateContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  sessionId?: string;
  turnId: string;
  attempt: number;
  transport: "stream" | "websocket";
};
/**
 * Provider-owned WebSocket session policy.
 *
 * Use this for session-scoped headers or cool-down behavior that should apply
 * before a generic WebSocket transport decides to retry or fall back.
 */
type ProviderWebSocketSessionPolicy = {
  headers?: Record<string, string>;
  degradeCooldownMs?: number;
};
/**
 * Provider-owned WebSocket session policy input.
 *
 * Use this when the provider wants to control native session handshake headers
 * or the post-failure cool-down window for a generic WebSocket transport.
 */
type ProviderResolveWebSocketSessionPolicyContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  sessionId?: string;
};
/**
 * Provider-owned failover error classification input.
 *
 * Use this when provider-specific transport or API errors need classification
 * hints that generic string matching cannot express safely.
 */
type ProviderFailoverErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
};
/**
 * Generic embedding provider shape returned by provider plugins.
 *
 * Keep this aligned with the memory embedding contract without forcing the
 * plugin system to import memory internals directly.
 */
type PluginEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: {
    signal?: AbortSignal;
  }) => Promise<number[]>;
  embedBatch: (texts: string[], options?: {
    signal?: AbortSignal;
  }) => Promise<number[][]>;
  embedBatchInputs?: (inputs: unknown[], options?: {
    signal?: AbortSignal;
  }) => Promise<number[][]>;
  client?: unknown;
};
/**
 * Provider-owned embedding transport creation.
 *
 * Use this when a provider wants memory embeddings to live with the provider
 * plugin instead of the core memory switchboard.
 */
type ProviderCreateEmbeddingProviderContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  providerApiKey?: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  outputDimensionality?: number;
  taskType?: string;
};
/**
 * Provider-owned prompt-cache eligibility.
 *
 * Return `true` or `false` to override OpenClaw's built-in provider cache TTL
 * detection for this provider. Return `undefined` to fall back to core rules.
 */
type ProviderCacheTtlEligibilityContext = {
  provider: string;
  modelId: string;
  modelApi?: string;
};
/**
 * Provider-owned missing-auth message override.
 *
 * Runs only after OpenClaw exhausts normal env/profile/config auth resolution
 * for the requested provider. Return a custom message to replace the generic
 * "No API key found" error.
 */
type ProviderBuildMissingAuthMessageContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  listProfileIds: (providerId: string) => string[];
};
/**
 * Provider-owned unknown-model hint override.
 *
 * Runs after catalog/runtime lookup misses for the requested provider. Return a
 * hint suffix that OpenClaw should append to the generic `Unknown model`
 * error.
 */
type ProviderBuildUnknownModelHintContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};
/**
 * Built-in model suppression hook context.
 *
 * @deprecated Use manifest `modelCatalog.suppressions`. Runtime suppression
 * hooks are no longer called by model resolution.
 */
type ProviderBuiltInModelSuppressionContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};
type ProviderBuiltInModelSuppressionResult = {
  suppress: boolean;
  errorMessage?: string;
};
/**
 * Provider-owned "modern model" policy input.
 *
 * Live smoke/model-profile selection uses this to keep provider-specific
 * inclusion/exclusion rules out of core.
 */
type ProviderModernModelPolicyContext = {
  provider: string;
  modelId: string;
};
/**
 * Final catalog augmentation hook.
 *
 * Runs after OpenClaw loads the discovered model catalog and merges configured
 * opt-in providers. Use this for forward-compat rows or vendor-owned synthetic
 * entries that should appear in `models list` and model pickers even when the
 * upstream registry has not caught up yet.
 */
type ProviderAugmentModelCatalogContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  entries: ModelCatalogEntry[];
};
/**
 * @deprecated Use ProviderCatalogOrder.
 */
type ProviderDiscoveryOrder = ProviderCatalogOrder;
/**
 * @deprecated Use ProviderCatalogContext.
 */
type ProviderDiscoveryContext = ProviderCatalogContext;
/**
 * @deprecated Use ProviderCatalogResult.
 */
type ProviderDiscoveryResult = ProviderCatalogResult;
/**
 * @deprecated Use ProviderPluginCatalog.
 */
type ProviderPluginDiscovery = ProviderPluginCatalog;
type ProviderPluginWizardSetup = {
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  onboardingFeatured?: boolean;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  methodId?: string;
  /**
   * Interactive onboarding surfaces where this auth choice should appear.
   * Defaults to `["text-inference"]` when omitted.
   */
  onboardingScopes?: Array<"text-inference" | "image-generation" | "music-generation">;
  /**
   * Optional model-allowlist prompt policy applied after this auth choice is
   * selected in configure/onboarding flows.
   *
   * Keep this UI-facing and static. Provider logic that needs runtime state
   * should stay in `run`/`runNonInteractive`.
   */
  modelAllowlist?: {
    allowedKeys?: string[];
    initialSelections?: string[];
    loadCatalog?: boolean;
    message?: string;
  };
  /**
   * Optional default-model prompt policy for this auth/setup choice.
   *
   * Use this when selecting the auth choice should still force a model picker
   * even if the choice was preseeded via CLI/configure, or when "keep current"
   * would skip required provider-owned post-selection work.
   */
  modelSelection?: {
    promptWhenAuthChoiceProvided?: boolean;
    allowKeepCurrent?: boolean;
  };
};
/** Optional model-picker metadata shown in interactive provider selection flows. */
type ProviderPluginWizardModelPicker = {
  label?: string;
  hint?: string;
  methodId?: string;
};
/** UI metadata that lets provider plugins appear in onboarding and configure flows. */
type ProviderPluginWizard = {
  setup?: ProviderPluginWizardSetup;
  modelPicker?: ProviderPluginWizardModelPicker;
};
type ProviderOAuthProfileIdRepair = {
  /**
   * Legacy OAuth profile id to migrate away from.
   *
   * When omitted, OpenClaw falls back to `<provider>:default`.
   */
  legacyProfileId?: string;
  /**
   * Optional custom doctor prompt label.
   *
   * Defaults to the provider label when omitted.
   */
  promptLabel?: string;
};
type ProviderModelSelectedContext = {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
};
type ProviderDeferSyntheticProfileAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
  resolvedApiKey?: string;
};
type ProviderSystemPromptContributionContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  promptMode: PromptMode;
  runtimeChannel?: string;
  runtimeCapabilities?: string[];
  agentId?: string;
  trigger?: "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
};
type ProviderTransformSystemPromptContext = ProviderSystemPromptContributionContext & {
  systemPrompt: string;
};
type PluginTextTransformRegistration = PluginTextTransforms;
/** Text-inference provider capability registered by a plugin. */
type ProviderPlugin = {
  id: string;
  pluginId?: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  /**
   * Internal-only aliases used for runtime/config hook lookup.
   *
   * Unlike `aliases`, these values are not treated as user-facing provider ids
   * for auth/setup surfaces. Use them for legacy config keys or compat-only
   * hook routing.
   */
  hookAliases?: string[];
  /**
   * Provider-related env vars shown in setup/search/help surfaces.
   *
   * Keep entries in preferred display order. This can include direct auth env
   * vars or setup inputs such as OAuth client id/secret vars.
   */
  envVars?: string[];
  auth: ProviderAuthMethod[];
  /**
   * Legacy text-provider catalog hook.
   *
   * @deprecated New catalog/control-plane surfaces should use
   * `api.registerModelCatalogProvider`. This hook remains the text runtime
   * source until the unified loader fully replaces it.
   * Returns provider config/model definitions that merge into models.providers.
   */
  catalog?: ProviderPluginCatalog;
  /**
   * Legacy offline text-provider catalog hook for display-only surfaces.
   *
   * @deprecated New static rows should be registered with
   * `api.registerModelCatalogProvider`.
   *
   * Unlike `catalog`, this hook must not perform network I/O or require real
   * credentials. Use it for bundled/static rows that can be shown before auth is
   * configured.
   */
  staticCatalog?: ProviderPluginCatalog;
  /**
   * Show catalog row labels as the literal `<provider>/<entry.id>`
   * composition instead of the canonical (deduped) key.
   *
   * `modelKey` strips a duplicate `<provider>/` prefix so storage and
   * lookups stay stable. This flag only changes the picker label — the
   * option value and persisted config remain canonical.
   *
   * Set when the leading `<provider>/` segment in the native model id is
   * a meaningful vendor namespace (e.g. NVIDIA's `nvidia/nemotron-...`
   * alongside `moonshotai/kimi-k2.5`).
   */
  preserveLiteralProviderPrefix?: boolean;
  /**
   * @deprecated Use catalog.
   *
   * Legacy alias for catalog.
   * Kept for compatibility with existing provider plugins.
   */
  discovery?: ProviderPluginDiscovery;
  /**
   * Sync runtime fallback for model ids not present in the local catalog.
   *
   * Hook order:
   * 1. discovered/static model lookup
   * 2. plugin `resolveDynamicModel`
   * 3. core fallback heuristics
   * 4. generic provider-config fallback
   *
   * Keep this hook cheap and deterministic. If you need network I/O first, use
   * `prepareDynamicModel` to prime state for the async retry path.
   */
  resolveDynamicModel?: (ctx: ProviderResolveDynamicModelContext) => ProviderRuntimeModel | null | undefined;
  /**
   * Optional async prefetch for dynamic model resolution.
   *
   * OpenClaw calls this only from async model resolution paths. After it
   * completes, `resolveDynamicModel` is called again.
   */
  prepareDynamicModel?: (ctx: ProviderPrepareDynamicModelContext) => Promise<void>;
  /**
   * Lets a provider plugin opt exact configured models into a runtime
   * metadata comparison pass before the embedded runner returns the explicit
   * entry unchanged.
   */
  preferRuntimeResolvedModel?: (ctx: ProviderPreferRuntimeResolvedModelContext) => boolean;
  /**
   * Provider-owned transport normalization.
   *
   * Use this to rewrite a resolved model without forking the generic runner:
   * swap API ids, update base URLs, or adjust compat flags for a provider's
   * transport quirks.
   */
  normalizeResolvedModel?: (ctx: ProviderNormalizeResolvedModelContext) => ProviderRuntimeModel | null | undefined;
  /**
   * Provider-owned compat contribution for resolved models outside direct
   * provider ownership.
   *
   * Use this when a plugin can recognize its vendor's models behind another
   * OpenAI-compatible transport (for example OpenRouter or a custom base URL)
   * and needs to contribute compat flags without taking over the provider.
   */
  contributeResolvedModelCompat?: (ctx: ProviderNormalizeResolvedModelContext) => Partial<ModelCompatConfig> | null | undefined;
  /**
   * Provider-owned model-id normalization.
   *
   * Runs before model lookup/canonicalization. Use this for alias cleanup such
   * as provider-owned preview/legacy model ids.
   */
  normalizeModelId?: (ctx: ProviderNormalizeModelIdContext) => string | null | undefined;
  /**
   * Provider-owned transport-family normalization before generic model
   * assembly.
   *
   * Use this for API/baseUrl cleanup that may apply to custom provider ids
   * which still target the provider's transport family.
   */
  normalizeTransport?: (ctx: ProviderNormalizeTransportContext) => {
    api?: string | null;
    baseUrl?: string;
  } | null | undefined;
  /**
   * Provider-owned config normalization for `models.providers.<id>`.
   *
   * Use this for provider-specific baseUrl/model-id cleanup that should stay
   * with the plugin rather than in core config-policy tables.
   */
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  /**
   * Provider-owned final native-streaming compat pass for config providers.
   *
   * Use this when a provider opts specific native base URLs into
   * `supportsUsageInStreaming` or similar transport compatibility flags.
   */
  applyNativeStreamingUsageCompat?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  /**
   * Provider-owned config apiKey/env marker resolution.
   *
   * Use this when a provider resolves auth from env vars such as AWS/GCP
   * markers rather than a normal API-key env var.
   */
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  /**
   * @deprecated Legacy static capability bag kept only for compatibility.
   *
   * New provider behavior should use explicit hooks instead. Core replay and
   * stream/runtime logic no longer consumes this field.
   */
  capabilities?: ProviderCapabilities;
  /**
   * Provider-owned replay/compaction policy override.
   *
   * Use this when transcript replay or compaction should follow provider-owned
   * rules that are more expressive than the static `capabilities` bag.
   */
  buildReplayPolicy?: (ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined;
  /**
   * Provider-owned replay-history sanitization.
   *
   * Runs after OpenClaw performs generic transcript cleanup. Use this for
   * provider-specific replay rewrites that should stay with the provider
   * plugin rather than in shared core compaction helpers.
   */
  sanitizeReplayHistory?: (ctx: ProviderSanitizeReplayHistoryContext) => Promise<AgentMessage[] | null | undefined> | AgentMessage[] | null | undefined;
  /**
   * Provider-owned final replay-turn validation.
   *
   * Use this when provider transports need stricter replay-time validation or
   * turn reshaping after generic sanitation. Returning a non-null value
   * replaces the built-in replay validators rather than composing with them.
   */
  validateReplayTurns?: (ctx: ProviderValidateReplayTurnsContext) => Promise<AgentMessage[] | null | undefined> | AgentMessage[] | null | undefined;
  /**
   * Provider-owned tool-schema normalization.
   *
   * Use this for transport-family schema cleanup before OpenClaw registers
   * tools with the embedded runner.
   */
  normalizeToolSchemas?: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[] | null | undefined;
  /**
   * Provider-owned tool-schema diagnostics after normalization.
   *
   * Use this when a provider wants to surface transport-specific schema
   * warnings without teaching core about provider-specific keyword rules.
   */
  inspectToolSchemas?: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[] | null | undefined;
  /**
   * Provider-owned reasoning output mode.
   *
   * Use this when a provider requires tagged reasoning/final output instead of
   * native structured reasoning fields.
   */
  resolveReasoningOutputMode?: (ctx: ProviderReasoningOutputModeContext) => ProviderReasoningOutputMode | null | undefined;
  /**
   * Provider-owned extra-param normalization before generic stream option
   * wrapping.
   *
   * Typical uses: set provider-default `transport`, map provider-specific
   * config aliases, or inject extra request metadata sourced from
   * `agents.defaults.models.<provider>/<model>.params`.
   */
  prepareExtraParams?: (ctx: ProviderPrepareExtraParamsContext) => Record<string, unknown> | null | undefined;
  /**
   * Provider-owned request params after transport/model resolution.
   *
   * Use this for transport-family request knobs that should be keyed by the
   * resolved model API/transport rather than a hardcoded core allowlist.
   */
  extraParamsForTransport?: (ctx: ProviderExtraParamsForTransportContext) => ProviderExtraParamsForTransportResult | null | undefined;
  /**
   * Provider-owned transport factory.
   *
   * Use this when the provider needs a fully custom StreamFn instead of a
   * wrapper around the normal `streamSimple` path.
   */
  createStreamFn?: (ctx: ProviderCreateStreamFnContext) => StreamFn | null | undefined;
  /**
   * Provider-owned stream wrapper applied after generic OpenClaw wrappers.
   *
   * Typical uses: provider attribution headers, request-body rewrites, or
   * provider-specific compat payload patches that do not justify a separate
   * transport implementation.
   */
  wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => StreamFn | null | undefined;
  /**
   * Provider-owned native transport turn identity.
   *
   * Use this when a provider wants generic transports to attach provider-native
   * request headers or metadata on each turn without hardcoding vendor logic in
   * core.
   */
  resolveTransportTurnState?: (ctx: ProviderResolveTransportTurnStateContext) => ProviderTransportTurnState | null | undefined;
  /**
   * Provider-owned WebSocket session policy.
   *
   * Use this when a provider wants generic WebSocket transports to attach
   * native session headers or tune the session-scoped cool-down before HTTP
   * fallback.
   */
  resolveWebSocketSessionPolicy?: (ctx: ProviderResolveWebSocketSessionPolicyContext) => ProviderWebSocketSessionPolicy | null | undefined;
  /**
   * Provider-owned embedding provider factory.
   *
   * Use this when memory embedding behavior belongs with the provider plugin
   * rather than the core embedding switchboard.
   */
  createEmbeddingProvider?: (ctx: ProviderCreateEmbeddingProviderContext) => Promise<PluginEmbeddingProvider | null | undefined> | PluginEmbeddingProvider | null | undefined;
  /**
   * Runtime auth exchange hook.
   *
   * Called after OpenClaw resolves the raw configured credential but before the
   * runner stores it in runtime auth storage. This lets plugins exchange a
   * source credential (for example a GitHub token) into a short-lived runtime
   * token plus optional base URL override.
   */
  prepareRuntimeAuth?: (ctx: ProviderPrepareRuntimeAuthContext) => Promise<ProviderPreparedRuntimeAuth | null | undefined>;
  /**
   * Usage/billing auth resolution hook.
   *
   * Called by provider-usage surfaces (`/usage`, status snapshots, reporting).
   * Use this when a provider's usage endpoint needs provider-owned token
   * extraction, blob parsing, or alias handling.
   */
  resolveUsageAuth?: (ctx: ProviderResolveUsageAuthContext) => Promise<ProviderResolvedUsageAuth | null | undefined> | ProviderResolvedUsageAuth | null | undefined;
  /**
   * Usage/quota snapshot fetch hook.
   *
   * Called after `resolveUsageAuth` by `/usage` and related reporting surfaces.
   * Use this when the provider's usage endpoint or payload shape is
   * provider-specific and you want that logic to live with the provider plugin
   * instead of the core switchboard.
   */
  fetchUsageSnapshot?: (ctx: ProviderFetchUsageSnapshotContext) => Promise<ProviderUsageSnapshot | null | undefined> | ProviderUsageSnapshot | null | undefined;
  /**
   * Provider-owned failover context-overflow matcher.
   *
   * Return true when the provider recognizes the raw error as a context-window
   * overflow shape that generic heuristics would miss.
   */
  matchesContextOverflowError?: (ctx: ProviderFailoverErrorContext) => boolean | undefined;
  /**
   * Provider-owned failover error classification.
   *
   * Return a failover reason when the provider recognizes a provider-specific
   * raw error shape. Return undefined to fall back to generic classification.
   */
  classifyFailoverReason?: (ctx: ProviderFailoverErrorContext) => FailoverReason | null | undefined;
  /**
   * Provider-owned cache TTL eligibility.
   *
   * Use this when a proxy provider supports Anthropic-style prompt caching for
   * only a subset of upstream models.
   */
  isCacheTtlEligible?: (ctx: ProviderCacheTtlEligibilityContext) => boolean | undefined;
  /**
   * Provider-owned missing-auth message override.
   *
   * Return a custom message when the provider wants a more specific recovery
   * hint than OpenClaw's generic auth-store guidance.
   */
  buildMissingAuthMessage?: (ctx: ProviderBuildMissingAuthMessageContext) => string | null | undefined;
  /**
   * Provider-owned unknown-model hint override.
   *
   * Return a suffix when the provider wants a more specific recovery hint than
   * OpenClaw's generic `Unknown model` error after catalog/runtime lookup
   * fails.
   */
  buildUnknownModelHint?: (ctx: ProviderBuildUnknownModelHintContext) => string | null | undefined;
  /**
   * Provider-owned built-in model suppression.
   *
   * Return `{ suppress: true }` to hide a stale upstream row. Include
   * `errorMessage` when OpenClaw should surface a provider-specific hint for
   * direct model resolution failures.
   *
   * @deprecated Use manifest `modelCatalog.suppressions`. Runtime suppression
   * hooks are no longer called by model resolution.
   */
  suppressBuiltInModel?: (ctx: ProviderBuiltInModelSuppressionContext) => ProviderBuiltInModelSuppressionResult | null | undefined;
  /**
   * Provider-owned final catalog augmentation.
   *
   * @deprecated Use `api.registerModelCatalogProvider` for supplemental catalog
   * rows. This hook is kept only for existing text-provider runtime
   * compatibility during the migration window.
   *
   * Return extra rows to append to the final catalog after discovery/config
   * merging. OpenClaw deduplicates by `provider/id`, so plugins only need to
   * describe the desired supplemental rows.
   */
  augmentModelCatalog?: (ctx: ProviderAugmentModelCatalogContext) => Array<ModelCatalogEntry> | ReadonlyArray<ModelCatalogEntry> | Promise<Array<ModelCatalogEntry> | ReadonlyArray<ModelCatalogEntry> | null | undefined> | null | undefined;
  /**
   * Provider-owned binary thinking toggle.
   *
   * Return true when the provider exposes a coarse on/off reasoning control
   * instead of the normal multi-level ladder shown by `/think`.
   *
   * @deprecated Prefer `resolveThinkingProfile`.
   */
  isBinaryThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  /**
   * Provider-owned xhigh reasoning support.
   *
   * Return true only for models that should expose the `xhigh` thinking level.
   *
   * @deprecated Prefer `resolveThinkingProfile`.
   */
  supportsXHighThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  /**
   * Provider-owned thinking level profile.
   *
   * Prefer this over the individual thinking capability hooks when a provider
   * or model exposes a custom set of thinking levels. OpenClaw stores the
   * canonical `id`, shows `label` when provided, and downgrades stale stored
   * values by profile rank.
   */
  resolveThinkingProfile?: (ctx: ProviderDefaultThinkingPolicyContext) => ProviderThinkingProfile | null | undefined;
  /**
   * Provider-owned default thinking level.
   *
   * Use this to keep model-family defaults (for example Claude 4.6 =>
   * adaptive) out of core command logic.
   *
   * @deprecated Prefer `resolveThinkingProfile`.
   */
  resolveDefaultThinkingLevel?: (ctx: ProviderDefaultThinkingPolicyContext) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
  /**
   * Provider-owned system-prompt contribution.
   *
   * Use this when a provider/model family needs cache-aware prompt tuning
   * without replacing the full OpenClaw-owned system prompt.
   */
  resolveSystemPromptContribution?: (ctx: ProviderSystemPromptContributionContext) => ProviderSystemPromptContribution | null | undefined;
  /**
   * Provider-owned GPT/model prompt overlay seam.
   *
   * Runs after OpenClaw's built-in overlay is resolved and before the
   * provider's regular system-prompt contribution is merged.
   */
  resolvePromptOverlay?: (ctx: ProviderResolvePromptOverlayContext) => ProviderSystemPromptContribution | null | undefined;
  /**
   * Provider-owned fallback route override for model/profile failure handling.
   *
   * Return undefined/null to keep OpenClaw's default fallback policy.
   */
  followupFallbackRoute?: (ctx: ProviderFollowupFallbackRouteContext) => ProviderFollowupFallbackRouteResult | null | undefined;
  /**
   * Provider-owned auth profile resolver.
   *
   * Return a profile id from the supplied order to prefer it for this attempt;
   * invalid or missing ids are ignored by core.
   */
  resolveAuthProfileId?: (ctx: ProviderResolveAuthProfileIdContext) => string | null | undefined;
  /**
   * Provider-owned final system-prompt transform.
   *
   * Use this sparingly when a provider transport needs small compatibility
   * rewrites after OpenClaw has assembled the complete prompt. Return
   * `undefined`/`null` to leave the prompt unchanged.
   */
  transformSystemPrompt?: (ctx: ProviderTransformSystemPromptContext) => string | null | undefined;
  /**
   * Provider-owned bidirectional text replacements.
   *
   * `input` applies to system prompts and text message content before transport.
   * `output` applies to assistant text deltas/final text before OpenClaw handles
   * its own control markers or channel delivery.
   */
  textTransforms?: PluginTextTransforms;
  /**
   * Provider-owned global config defaults.
   *
   * Use this when config materialization needs provider-specific defaults that
   * depend on auth mode, env, or provider model-family semantics.
   */
  applyConfigDefaults?: (ctx: ProviderApplyConfigDefaultsContext) => OpenClawConfig | null | undefined;
  /**
   * Provider-owned "modern model" matcher used by live profile/smoke filters.
   *
   * Return true when the given provider/model ref should be treated as a
   * preferred modern model candidate.
   */
  isModernModelRef?: (ctx: ProviderModernModelPolicyContext) => boolean | undefined;
  wizard?: ProviderPluginWizard;
  /**
   * Provider-owned auth-profile API-key formatter.
   *
   * OpenClaw uses this when a stored auth profile is already valid and needs to
   * be converted into the runtime `apiKey` string expected by the provider. Use
   * this for providers whose auth profile stores extra metadata alongside the
   * bearer token (for example Gemini CLI's `{ token, projectId }` payload).
   */
  formatApiKey?: (cred: AuthProfileCredential) => string;
  /**
   * Legacy auth-profile ids that should be retired by `openclaw doctor`.
   *
   * Use this when a provider plugin replaces an older core-managed profile id
   * and wants cleanup/migration messaging to live with the provider instead of
   * in hardcoded doctor tables.
   */
  deprecatedProfileIds?: string[];
  /**
   * Legacy OAuth profile-id migrations that `openclaw doctor` should offer.
   *
   * Use this when a provider moved from a legacy default OAuth profile id to a
   * newer identity-based id and wants doctor to own the config rewrite without
   * another core-specific migration branch.
   */
  oauthProfileIdRepairs?: ProviderOAuthProfileIdRepair[];
  /**
   * Provider-owned OAuth refresh.
   *
   * OpenClaw calls this before falling back to the shared `pi-ai` OAuth
   * refreshers. Use it when the provider has a custom refresh endpoint, or when
   * the provider needs custom refresh-failure behavior that should stay out of
   * core auth-profile code.
   */
  refreshOAuth?: (cred: OAuthCredential) => Promise<OAuthCredential>;
  /**
   * Provider-owned auth-doctor hint.
   *
   * Return a multiline repair hint when OAuth refresh fails and the provider
   * wants to steer users toward a specific auth-profile migration or recovery
   * path. Return nothing to keep OpenClaw's generic error text.
   */
  buildAuthDoctorHint?: (ctx: ProviderAuthDoctorHintContext) => string | Promise<string | null | undefined> | null | undefined;
  /**
   * Provider-owned config-backed auth resolution.
   *
   * Providers own any provider-specific fallback secret rules here so core
   * auth/discovery code can stay generic and avoid parsing provider-private
   * config layouts.
   *
   * The returned `apiKey` may be:
   * - a real credential from the active runtime snapshot, suitable for runtime use
   * - a non-secret marker (for example a managed SecretRef marker), suitable only
   *   for discovery/bootstrap callers
   *
   * Runtime callers must not treat non-secret markers as runnable credentials;
   * they should retry against the active runtime snapshot when available.
   *
   * This hook is the canonical seam for provider-specific fallback auth
   * derived from plugin/private config. It may return:
   * - a runnable literal credential for runtime callers
   * - a non-secret marker for managed-secret source config, which is still useful
   *   for discovery/bootstrap callers
   *
   * Runtime callers must not treat non-secret markers as runnable credentials;
   * they should retry against the active runtime snapshot when available.
   *
   * Use this when the provider can operate without a real secret for certain
   * configured local/self-hosted cases and wants auth resolution to treat that
   * config as available.
   */
  resolveSyntheticAuth?: (ctx: ProviderResolveSyntheticAuthContext) => ProviderSyntheticAuthResult | null | undefined;
  /**
   * Provider-owned external auth profile discovery.
   *
   * Use this when credentials are managed by an external tool and should be visible
   * to runtime auth resolution without being written back into `auth-profiles.json`
   * by core.
   */
  resolveExternalAuthProfiles?: (ctx: ProviderResolveExternalAuthProfilesContext) => Array<ProviderExternalAuthProfile> | ReadonlyArray<ProviderExternalAuthProfile> | null | undefined;
  /**
   * @deprecated Declare `contracts.externalAuthProviders` in the plugin manifest
   * and implement `resolveExternalAuthProfiles` instead. This compatibility hook
   * is loaded through a slower fallback path and will be removed in a future release.
   */
  resolveExternalOAuthProfiles?: (ctx: ProviderResolveExternalOAuthProfilesContext) => Array<ProviderExternalOAuthProfile> | ReadonlyArray<ProviderExternalOAuthProfile> | null | undefined;
  /**
   * Provider-owned precedence rule for stored synthetic auth profiles.
   *
   * Return true when a stored profile API key is only a provider-owned
   * synthetic placeholder and should yield to env/config-backed auth before
   * OpenClaw falls back to that stored profile.
   */
  shouldDeferSyntheticProfileAuth?: (ctx: ProviderDeferSyntheticProfileAuthContext) => boolean | undefined;
  onModelSelected?: (ctx: ProviderModelSelectedContext) => Promise<void>;
};
/** Speech capability registered by a plugin. */
type SpeechProviderPlugin = {
  id: SpeechProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number; /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  models?: readonly string[];
  voices?: readonly string[];
  resolveConfig?: (ctx: SpeechProviderResolveConfigContext) => SpeechProviderConfig;
  parseDirectiveToken?: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult;
  resolveTalkConfig?: (ctx: SpeechProviderResolveTalkConfigContext) => SpeechProviderConfig;
  resolveTalkOverrides?: (ctx: SpeechProviderResolveTalkOverridesContext) => SpeechProviderConfig | undefined;
  prepareSynthesis?: (ctx: SpeechProviderPrepareSynthesisContext) => SpeechProviderPreparedSynthesis | undefined | Promise<SpeechProviderPreparedSynthesis | undefined>;
  isConfigured: (ctx: SpeechProviderConfiguredContext) => boolean;
  synthesize: (req: SpeechSynthesisRequest) => Promise<SpeechSynthesisResult>;
  streamSynthesize?: (req: SpeechSynthesisStreamRequest) => Promise<SpeechSynthesisStreamResult>;
  synthesizeTelephony?: (req: SpeechTelephonySynthesisRequest) => Promise<SpeechTelephonySynthesisResult>;
  listVoices?: (req: SpeechListVoicesRequest) => Promise<SpeechVoiceOption[]>;
};
type PluginSpeechProviderEntry = SpeechProviderPlugin & {
  pluginId: string;
};
/** Realtime transcription capability registered by a plugin. */
type RealtimeTranscriptionProviderPlugin = {
  id: RealtimeTranscriptionProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  autoSelectOrder?: number;
  resolveConfig?: (ctx: RealtimeTranscriptionProviderResolveConfigContext) => RealtimeTranscriptionProviderConfig;
  isConfigured: (ctx: RealtimeTranscriptionProviderConfiguredContext) => boolean;
  createSession: (req: RealtimeTranscriptionSessionCreateRequest) => RealtimeTranscriptionSession;
};
type PluginRealtimeTranscriptionProviderEntry = RealtimeTranscriptionProviderPlugin & {
  pluginId: string;
};
/** Realtime voice capability registered by a plugin. */
type RealtimeVoiceProviderPlugin = {
  id: RealtimeVoiceProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  autoSelectOrder?: number;
  capabilities?: RealtimeVoiceProviderCapabilities;
  resolveConfig?: (ctx: RealtimeVoiceProviderResolveConfigContext) => RealtimeVoiceProviderConfig;
  isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => boolean;
  createBridge: (req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
  createBrowserSession?: (req: RealtimeVoiceBrowserSessionCreateRequest) => Promise<RealtimeVoiceBrowserSession>;
};
type PluginRealtimeVoiceProviderEntry = RealtimeVoiceProviderPlugin & {
  pluginId: string;
};
type MediaUnderstandingProviderPlugin = MediaUnderstandingProvider;
type ImageGenerationProviderPlugin = ImageGenerationProvider;
type VideoGenerationProviderPlugin = VideoGenerationProvider;
type MusicGenerationProviderPlugin = MusicGenerationProvider;
type OpenClawPluginGatewayMethod = {
  method: string;
  handler: GatewayRequestHandler;
};
type PluginCommandDiagnosticsSession = {
  /** Stable host session key when available. */sessionKey?: string; /** Ephemeral OpenClaw session id when available. */
  sessionId?: string; /** Transcript file for this OpenClaw session when available. */
  sessionFile?: string; /** Embedded agent harness selected for this session. */
  agentHarnessId?: string; /** Channel/provider for this session when available. */
  channel?: string; /** Provider channel id when available. */
  channelId?: ChannelId; /** Account id for multi-account channels when available. */
  accountId?: string; /** Thread/topic id when available. */
  messageThreadId?: string | number; /** Parent conversation id for thread-capable channels when available. */
  threadParentId?: string;
};
/**
 * Context passed to plugin command handlers.
 */
type PluginCommandContext = {
  /** The sender's identifier (for example a channel-scoped user ID) */senderId?: string; /** The channel/surface (for example "chat" or "team-chat") */
  channel: string; /** Provider channel id */
  channelId?: ChannelId; /** Whether the sender is on the allowlist */
  isAuthorizedSender: boolean; /** Whether the sender is an owner for owner-only command surfaces. */
  senderIsOwner?: boolean; /** Gateway client scopes for internal control-plane callers */
  gatewayClientScopes?: string[]; /** Stable host session key for the active conversation when available. */
  sessionKey?: string; /** Ephemeral host session id for the active conversation when available. */
  sessionId?: string; /** Transcript file for the active OpenClaw session when available. */
  sessionFile?: string; /** Raw command arguments after the command name */
  args?: string; /** The full normalized command body */
  commandBody: string; /** Current OpenClaw configuration */
  config: OpenClawConfig; /** Raw "From" value (channel-scoped id) */
  from?: string; /** Raw "To" value (channel-scoped id) */
  to?: string; /** Account id for multi-account channels */
  accountId?: string; /** Thread/topic id if available */
  messageThreadId?: string | number; /** Parent conversation id for thread-capable channels */
  threadParentId?: string; /** Sensitive diagnostics-only session inventory for owner-gated commands. */
  diagnosticsSessions?: PluginCommandDiagnosticsSession[]; /** Internal diagnostics-only marker that exec approval already authorized upload. */
  diagnosticsUploadApproved?: boolean; /** Internal diagnostics-only marker to preview upload effects without exposing ids. */
  diagnosticsPreviewOnly?: boolean; /** Internal diagnostics-only marker for owner-private routed confirmations. */
  diagnosticsPrivateRouted?: boolean;
  requestConversationBinding: (params?: PluginConversationBindingRequestParams) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{
    removed: boolean;
  }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};
/**
 * Result returned by a plugin command handler.
 */
type PluginCommandResult = ReplyPayload & {
  continueAgent?: boolean;
};
/**
 * Handler function for plugin commands.
 */
type PluginCommandHandler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
/**
 * Definition for a plugin-registered command.
 */
declare const AGENT_PROMPT_SURFACE_KINDS: readonly ["pi_main", "codex_app_server", "cli_backend", "acp_backend", "subagent"];
type AgentPromptSurfaceKind = (typeof AGENT_PROMPT_SURFACE_KINDS)[number];
type AgentPromptGuidanceEntry = {
  text: string;
  surfaces?: readonly AgentPromptSurfaceKind[];
};
type AgentPromptGuidance = string | AgentPromptGuidanceEntry;
type OpenClawPluginCommandDefinition = {
  /** Command name without leading slash (e.g., "tts") */name: string;
  /**
   * Optional native-command aliases for slash/menu surfaces.
   * `default` applies to all native providers unless a provider-specific
   * override exists (for example `{ default: "talkvoice", teamChat: "voice2" }`).
   */
  nativeNames?: Partial<Record<string, string>> & {
    default?: string;
  };
  /**
   * Optional native progress placeholder text for native command surfaces.
   * `default` applies to all native providers unless a provider-specific
   * override exists.
   */
  nativeProgressMessages?: Partial<Record<string, string>> & {
    default?: string;
  }; /** Description shown in /help and command menus */
  description: string; /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
  /**
   * Optional channel ids this command belongs to.
   * Omit to keep the command available on every channel surface.
   */
  channels?: readonly string[]; /** Optional system-prompt guidance for agents when this command is registered. */
  agentPromptGuidance?: readonly AgentPromptGuidance[]; /** Whether this command accepts arguments */
  acceptsArgs?: boolean; /** Whether only authorized senders can use this command (default: true) */
  requireAuth?: boolean; /** Operator scopes required by gateway clients; command owners may satisfy this on chat surfaces. */
  requiredScopes?: OperatorScope[];
  /**
   * Allows a bundled plugin to claim a command name that is otherwise reserved
   * by core. External plugins cannot use this field.
   */
  ownership?: "plugin" | "reserved"; /** The handler function */
  handler: PluginCommandHandler;
};
type PluginInteractiveHandlerResult = {
  handled?: boolean;
} | void;
type PluginInteractiveRegistration<TContext = unknown, TChannel extends string = string, TResult = PluginInteractiveHandlerResult> = {
  channel: TChannel;
  namespace: string;
  handler: (ctx: TContext) => Promise<TResult> | TResult;
};
type PluginInteractiveHandlerRegistration = PluginInteractiveRegistration;
type OpenClawPluginHttpRouteAuth = "gateway" | "plugin";
type OpenClawPluginHttpRouteMatch = "exact" | "prefix";
type OpenClawPluginGatewayRuntimeScopeSurface = "write-default" | "trusted-operator";
type OpenClawPluginHttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
type OpenClawPluginHttpRouteUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean | void> | boolean | void;
type OpenClawPluginHttpRouteParams = {
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  handleUpgrade?: OpenClawPluginHttpRouteUpgradeHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match?: OpenClawPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
  nodeCapability?: {
    surface: string;
    ttlMs?: number;
  };
  replaceExisting?: boolean;
};
type OpenClawPluginHostedMediaResolver = (mediaUrl: string) => string | null | undefined | Promise<string | null | undefined>;
type OpenClawPluginCliContext = {
  /**
   * Command object where this plugin should register its commands.
   *
   * For root CLI registrations this is the root `openclaw` program. For nested
   * registrations it is the resolved parent command from `parentPath`.
   */
  program: Command;
  parentPath: readonly string[];
  config: OpenClawConfig;
  workspaceDir?: string;
  logger: PluginLogger;
};
type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>;
/**
 * Top-level CLI metadata for plugin-owned commands.
 *
 * Descriptors are the parse-time contract for lazy plugin CLI registration.
 * If you want OpenClaw to keep a plugin command lazy-loaded while still
 * advertising it at the root CLI level, provide descriptors that cover every
 * top-level command root registered by that plugin CLI surface.
 */
type OpenClawPluginCliCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};
type OpenClawPluginNodeCliFeatureOptions = {
  /** Explicit node feature command names owned under `openclaw nodes`. */commands?: string[];
  /**
   * Parse-time command descriptors for lazy node feature CLI registration.
   *
   * Descriptors are registered under `openclaw nodes`, so a descriptor named
   * `"camera"` exposes `openclaw nodes camera`.
   */
  descriptors?: OpenClawPluginCliCommandDescriptor[];
};
type OpenClawPluginReloadRegistration = {
  restartPrefixes?: string[];
  hotPrefixes?: string[];
  noopPrefixes?: string[];
};
type OpenClawPluginNodeHostCommand = {
  command: string;
  cap?: string;
  dangerous?: boolean;
  handle: (paramsJSON?: string | null) => Promise<string>;
};
type OpenClawPluginNodeInvokeTransportResult = {
  ok: true;
  payload?: unknown;
  payloadJSON?: string | null;
} | {
  ok: false;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
};
type OpenClawPluginNodeInvokeApprovalDecision = "allow-once" | "allow-always" | "deny";
type OpenClawPluginNodeInvokePolicyApprovalRuntime = {
  request: (input: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    toolName?: string;
    toolCallId?: string;
    agentId?: string;
    sessionKey?: string;
    timeoutMs?: number;
  }) => Promise<{
    id?: string;
    decision?: OpenClawPluginNodeInvokeApprovalDecision | null;
  }>;
};
type OpenClawPluginNodeInvokePolicyContext = {
  nodeId: string;
  command: string;
  params: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  node?: {
    nodeId: string;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    commands?: string[];
  };
  client?: {
    connId?: string;
    scopes?: string[];
  } | null;
  approvals?: OpenClawPluginNodeInvokePolicyApprovalRuntime;
  invokeNode: (input?: {
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) => Promise<OpenClawPluginNodeInvokeTransportResult>;
};
type OpenClawPluginNodeInvokePolicyResult = {
  ok: true;
  payload?: unknown;
  payloadJSON?: string | null;
} | {
  ok: false;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  unavailable?: boolean;
};
type OpenClawPluginNodeInvokePolicy = {
  commands: string[];
  /**
   * Platforms where these node-handled commands should be allowlisted by default.
   * Omit for commands that require explicit `gateway.nodes.allowCommands`.
   */
  defaultPlatforms?: Array<"ios" | "android" | "macos" | "windows" | "linux" | "unknown">;
  /**
   * Dangerous policy commands are filtered out of default allowlists unless
   * explicitly allowed by config.
   */
  dangerous?: boolean;
  /**
   * iOS foreground-restricted commands should be queued for foreground delivery
   * when an iOS node reports BACKGROUND_UNAVAILABLE.
   */
  foregroundRestrictedOnIos?: boolean;
  handle: (ctx: OpenClawPluginNodeInvokePolicyContext) => Promise<OpenClawPluginNodeInvokePolicyResult> | OpenClawPluginNodeInvokePolicyResult;
};
type OpenClawPluginSecurityAuditContext = {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  configPath: string;
};
type OpenClawPluginSecurityAuditCollector = (ctx: OpenClawPluginSecurityAuditContext) => SecurityAuditFinding[] | Promise<SecurityAuditFinding[]>;
type OpenClawGatewayDiscoveryAdvertiseContext = {
  machineDisplayName: string;
  gatewayPort: number;
  gatewayTlsEnabled: boolean;
  gatewayTlsFingerprintSha256?: string;
  gatewayDirectReachable: boolean;
  canvasPort?: number;
  tailnetDns?: string;
  sshPort?: number;
  cliPath?: string;
  minimal: boolean;
};
type OpenClawGatewayDiscoveryService = {
  id: string;
  advertise: (ctx: OpenClawGatewayDiscoveryAdvertiseContext) => void | Promise<void | {
    stop?: () => void | Promise<void>;
  }>;
};
/** Context passed to long-lived plugin services. */
type OpenClawPluginServiceContext = {
  config: OpenClawConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
  startupTrace?: {
    detail?: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
    measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
  };
  internalDiagnostics?: {
    emit: (event: DiagnosticEventInput) => void;
    onEvent: (listener: (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void) => () => void;
  };
};
/** Background service registered by a plugin during `register(api)`. */
type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};
type OpenClawPluginChannelRegistration = {
  plugin: ChannelPlugin;
};
/** Module-level plugin definition loaded from a native plugin entry file. */
type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  /**
   * @deprecated Declare exclusive plugin kind in `openclaw.plugin.json` via
   * manifest `kind`. Runtime-exported `kind` is kept as a compatibility
   * fallback for older plugins and may require loading plugin runtime on
   * metadata-only command paths.
   */
  kind?: PluginKind | PluginKind[];
  configSchema?: OpenClawPluginConfigSchema;
  reload?: OpenClawPluginReloadRegistration;
  nodeHostCommands?: OpenClawPluginNodeHostCommand[];
  securityAuditCollectors?: OpenClawPluginSecurityAuditCollector[];
  register?: (api: OpenClawPluginApi) => void;
  activate?: (api: OpenClawPluginApi) => void;
};
type OpenClawPluginModule = OpenClawPluginDefinition | ((api: OpenClawPluginApi) => void);
/**
 * Public label exposed to plugin `register(api)` calls.
 *
 * Keep this as a compatibility signal for plugin authors. Loader internals
 * should derive explicit capability booleans from the mode instead of branching
 * on raw strings throughout the code path.
 *
 * - `full`: live runtime activation; long-lived side effects may start.
 * - `discovery`: read-only capability discovery; skip sockets/workers/clients.
 * - `tool-discovery`: capability discovery for executable tools; skip channel runtime hydration.
 * - `setup-only`: lightweight channel setup entry only.
 * - `setup-runtime`: setup flow that also needs the runtime channel entry.
 * - `cli-metadata`: CLI command metadata collection.
 */
type PluginRegistrationMode = "full" | "discovery" | "tool-discovery" | "setup-only" | "setup-runtime" | "cli-metadata";
type PluginConfigMigration = (config: OpenClawConfig) => {
  config: OpenClawConfig;
  changes: string[];
} | null | undefined;
type MigrationItemStatus = "planned" | "migrated" | "skipped" | "warning" | "conflict" | "error";
type MigrationItemKind = "config" | "secret" | "memory" | "skill" | "workspace" | "session" | "file" | "archive" | "manual";
type MigrationItemAction = "copy" | "create" | "update" | "merge" | "append" | "archive" | "skip" | "manual";
type MigrationItem = {
  id: string;
  kind: MigrationItemKind | (string & {});
  action: MigrationItemAction | (string & {});
  status: MigrationItemStatus;
  source?: string;
  target?: string;
  message?: string;
  reason?: string;
  sensitive?: boolean;
  details?: Record<string, unknown>;
};
type MigrationSummary = {
  total: number;
  planned: number;
  migrated: number;
  skipped: number;
  conflicts: number;
  errors: number;
  sensitive: number;
};
type MigrationDetection = {
  found: boolean;
  source?: string;
  label?: string;
  confidence?: "low" | "medium" | "high";
  message?: string;
};
type MigrationPlan = {
  providerId: string;
  source: string;
  target?: string;
  summary: MigrationSummary;
  items: MigrationItem[];
  warnings?: string[];
  nextSteps?: string[];
  metadata?: Record<string, unknown>;
};
type MigrationApplyResult = MigrationPlan & {
  backupPath?: string;
  reportDir?: string;
};
type MigrationProviderPreparation = {
  dispose?: () => void | Promise<void>;
};
type MigrationProviderContext = {
  config: OpenClawConfig;
  runtime?: PluginRuntime;
  logger: PluginLogger;
  stateDir: string;
  source?: string;
  includeSecrets?: boolean;
  overwrite?: boolean;
  providerOptions?: Record<string, unknown>;
  backupPath?: string;
  reportDir?: string;
  signal?: AbortSignal;
};
/** Migration source implemented by a plugin and orchestrated by `openclaw migrate`. */
type MigrationProviderPlugin = {
  id: string;
  label: string;
  description?: string;
  detect?: (ctx: MigrationProviderContext) => MigrationDetection | Promise<MigrationDetection>;
  prepareApply?: (ctx: MigrationProviderContext) => MigrationProviderPreparation | Promise<MigrationProviderPreparation | undefined> | undefined;
  plan: (ctx: MigrationProviderContext) => MigrationPlan | Promise<MigrationPlan>;
  apply: (ctx: MigrationProviderContext, plan?: MigrationPlan) => MigrationApplyResult | Promise<MigrationApplyResult>;
};
type PluginSetupAutoEnableContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};
type PluginSetupAutoEnableProbe = (ctx: PluginSetupAutoEnableContext) => string | string[] | null | undefined;
type OpenClawPluginSessionStateApi = {
  /** Register plugin-owned session state projected into Gateway session rows. */registerSessionExtension: (extension: PluginSessionExtensionRegistration) => void;
};
type OpenClawPluginSessionWorkflowApi = {
  /** Queue one plugin-owned context injection for the next agent turn in a session. */enqueueNextTurnInjection: (injection: PluginNextTurnInjection) => Promise<PluginNextTurnInjectionEnqueueResult>;
  /**
   * Register cleanup metadata for a plugin-owned session scheduler job.
   * This does not schedule work or create task records; it only lets the host
   * clean external scheduler state during reset/delete/disable.
   */
  registerSessionSchedulerJob: (job: PluginSessionSchedulerJobRegistration) => PluginSessionSchedulerJobHandle | undefined; /** Send host-validated files to the active direct-outbound route for a session. */
  sendSessionAttachment: (params: PluginSessionAttachmentParams) => Promise<PluginSessionAttachmentResult>;
  /**
   * Schedule a future agent turn in a session through Cron.
   * Cron owns timing and creates the task ledger entry when the turn runs.
   */
  scheduleSessionTurn: (params: PluginSessionTurnScheduleParams) => Promise<PluginSessionSchedulerJobHandle | undefined>; /** Remove Cron-backed scheduled session turns that share a plugin-owned tag. */
  unscheduleSessionTurnsByTag: (params: PluginSessionTurnUnscheduleByTagParams) => Promise<PluginSessionTurnUnscheduleByTagResult>;
};
type OpenClawPluginSessionControlsApi = {
  /** Register a typed session action that clients can dispatch through the Gateway. */registerSessionAction: (action: PluginSessionActionRegistration) => void; /** Register a generic Control UI contribution descriptor. */
  registerControlUiDescriptor: (descriptor: PluginControlUiDescriptor) => void;
};
type OpenClawPluginSessionApi = {
  state: OpenClawPluginSessionStateApi;
  workflow: OpenClawPluginSessionWorkflowApi;
  controls: OpenClawPluginSessionControlsApi;
};
type OpenClawPluginAgentEventsApi = {
  /** Subscribe to sanitized agent events through the host-owned plugin lifecycle. */registerAgentEventSubscription: (subscription: PluginAgentEventSubscriptionRegistration) => void; /** Emit a host-routed, plugin-attributed event for workflow/UI subscribers. */
  emitAgentEvent: (params: PluginAgentEventEmitParams) => PluginAgentEventEmitResult;
};
type OpenClawPluginAgentApi = {
  events: OpenClawPluginAgentEventsApi;
};
type OpenClawPluginRunContextApi = {
  /** Store namespaced, JSON-compatible data for the active run. Cleared on run end/error. */setRunContext: (patch: PluginRunContextPatch) => boolean; /** Read namespaced plugin data for a run. */
  getRunContext: (params: PluginRunContextGetParams) => PluginJsonValue | undefined; /** Clear one namespace or all namespaces this plugin owns for a run. */
  clearRunContext: (params: {
    runId: string;
    namespace?: string;
  }) => void;
};
type OpenClawPluginLifecycleApi = {
  /** Register cleanup hooks for plugin-owned host state and background work. */registerRuntimeLifecycle: (lifecycle: PluginRuntimeLifecycleRegistration) => void;
};
/** Main registration API injected into native plugin entry files. */
type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: PluginRegistrationMode;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  /**
   * In-process runtime helpers for trusted native plugins.
   *
   * This surface is broader than hooks. Prefer hooks for third-party
   * automation/integration unless you need native registry integration.
   */
  runtime: PluginRuntime;
  logger: PluginLogger;
  /**
   * Grouped facade over the existing flat session-related plugin API.
   * Flat methods remain supported for compatibility.
   */
  session: OpenClawPluginSessionApi; /** Grouped facade for agent-event workflow seams. */
  agent: OpenClawPluginAgentApi; /** Grouped facade for run-scoped plugin scratch state. */
  runContext: OpenClawPluginRunContextApi; /** Grouped facade for plugin-owned lifecycle cleanup hooks. */
  lifecycle: OpenClawPluginLifecycleApi;
  registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?: OpenClawPluginToolOptions) => void;
  registerHook: (events: string | string[], handler: InternalHookHandler, opts?: OpenClawPluginHookOptions) => void;
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void; /** Register a plugin-owned resolver for browser-style hosted media URLs. */
  registerHostedMediaResolver: (resolver: OpenClawPluginHostedMediaResolver) => void; /** Register a native messaging channel plugin (channel capability). */
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  /**
   * Register a gateway RPC method for this plugin.
   *
   * Reserved core admin namespaces (`config.*`, `exec.approvals.*`,
   * `wizard.*`, `update.*`) always normalize to `operator.admin` even if a
   * narrower scope is requested.
   */
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler, opts?: {
    scope?: OperatorScope;
  }) => void;
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: {
    /** Parent command path for nested command groups, for example `["nodes"]`. */parentPath?: string[]; /** Explicit command names owned by this registrar at `parentPath`. */
    commands?: string[];
    /**
     * Parse-time command descriptors for lazy CLI registration.
     *
     * When descriptors cover every command exposed at `parentPath`, OpenClaw
     * can keep the plugin registrar lazy. Command-only registrations stay on
     * the eager compatibility path.
     */
    descriptors?: OpenClawPluginCliCommandDescriptor[];
  }) => void;
  /**
   * Register a plugin-owned node feature command group under `openclaw nodes`.
   *
   * This is equivalent to `registerCli(registrar, { parentPath: ["nodes"], ... })`
   * and is intended for paired-node capabilities such as camera, screen, or Canvas.
   */
  registerNodeCliFeature: (registrar: OpenClawPluginCliRegistrar, opts?: OpenClawPluginNodeCliFeatureOptions) => void;
  registerReload: (registration: OpenClawPluginReloadRegistration) => void;
  registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => void;
  registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => void;
  registerSecurityAuditCollector: (collector: OpenClawPluginSecurityAuditCollector) => void;
  registerService: (service: OpenClawPluginService) => void; /** Register a local gateway discovery advertiser such as mDNS/Bonjour. */
  registerGatewayDiscoveryService: (service: OpenClawGatewayDiscoveryService) => void; /** Register a text-only CLI backend used by the local CLI runner. */
  registerCliBackend: (backend: CliBackendPlugin) => void; /** Register plugin-owned prompt/message compatibility text transforms. */
  registerTextTransforms: (transforms: PluginTextTransformRegistration) => void; /** Register a lightweight config migration that can run before plugin runtime loads. */
  registerConfigMigration: (migrate: PluginConfigMigration) => void; /** Register an importer for `openclaw migrate` (migration capability). */
  registerMigrationProvider: (provider: MigrationProviderPlugin) => void; /** Register a lightweight config probe that can auto-enable this plugin generically. */
  registerAutoEnableProbe: (probe: PluginSetupAutoEnableProbe) => void; /** Register a native model/provider plugin (text inference capability). */
  registerProvider: (provider: ProviderPlugin) => void; /** Register provider-owned model catalog rows for text and media generation. */
  registerModelCatalogProvider: (provider: UnifiedModelCatalogProviderPlugin) => void; /** Register a general embedding provider (embedding capability). */
  registerEmbeddingProvider: (adapter: EmbeddingProviderAdapter) => void; /** Register a speech synthesis provider (speech capability). */
  registerSpeechProvider: (provider: SpeechProviderPlugin) => void; /** Register a realtime transcription provider (streaming STT capability). */
  registerRealtimeTranscriptionProvider: (provider: RealtimeTranscriptionProviderPlugin) => void; /** Register a realtime voice provider (duplex voice capability). */
  registerRealtimeVoiceProvider: (provider: RealtimeVoiceProviderPlugin) => void; /** Register a media understanding provider (media understanding capability). */
  registerMediaUnderstandingProvider: (provider: MediaUnderstandingProviderPlugin) => void; /** Register an image generation provider (image generation capability). */
  registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void; /** Register a video generation provider (video generation capability). */
  registerVideoGenerationProvider: (provider: VideoGenerationProviderPlugin) => void; /** Register a music generation provider (music generation capability). */
  registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void; /** Register a web fetch provider (web fetch capability). */
  registerWebFetchProvider: (provider: WebFetchProviderPlugin) => void; /** Register a web search provider (web search capability). */
  registerWebSearchProvider: (provider: WebSearchProviderPlugin) => void;
  registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => void;
  onConversationBindingResolved: (handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>) => void;
  /**
   * Register a custom command that bypasses the LLM agent.
   * Plugin commands are processed before built-in commands and before agent invocation.
   * Use this for simple state-toggling or status commands that don't need AI reasoning.
   */
  registerCommand: (command: OpenClawPluginCommandDefinition) => void; /** Register a context engine implementation (exclusive slot - only one active at a time). */
  registerContextEngine: (id: string, factory: ContextEngineFactory) => void; /** Register a compaction provider (pluggable summarization backend). */
  registerCompactionProvider: (provider: CompactionProvider) => void; /** Register an agent harness implementation. */
  registerAgentHarness: (harness: AgentHarness) => void;
  /**
   * Register a Codex app-server extension factory for Codex harness tool-result
   * middleware. Only bundled plugins may use this seam, and
   * `contracts.embeddedExtensionFactories` must include `"codex-app-server"`.
   */
  registerCodexAppServerExtensionFactory: (factory: CodexAppServerExtensionFactory) => void;
  /**
   * Register runtime-neutral tool-result middleware. Declare
   * `contracts.agentToolResultMiddleware` for every targeted runtime.
   */
  registerAgentToolResultMiddleware: (handler: AgentToolResultMiddleware, options?: AgentToolResultMiddlewareOptions) => void;
  /**
   * Register plugin-owned session state that can be projected into Gateway session rows.
   * @deprecated Use `api.session.state.registerSessionExtension(...)`.
   */
  registerSessionExtension: (extension: PluginSessionExtensionRegistration) => void;
  /**
   * Queue one plugin-owned context injection for the next agent turn in a session.
   * @deprecated Use `api.session.workflow.enqueueNextTurnInjection(...)`.
   */
  enqueueNextTurnInjection: (injection: PluginNextTurnInjection) => Promise<PluginNextTurnInjectionEnqueueResult>;
  /**
   * Register a trusted pre-tool policy. Only bundled plugins may use this
   * before-tool-call policy tier.
   */
  registerTrustedToolPolicy: (policy: PluginTrustedToolPolicyRegistration) => void;
  /**
   * Register display/policy metadata for a plugin-owned tool. Metadata is
   * scoped to the (pluginId, toolName) pair at projection time, so plugins
   * cannot decorate other plugins' tools or core tools through this surface.
   */
  registerToolMetadata: (metadata: PluginToolMetadataRegistration) => void;
  /**
   * Register a generic Control UI contribution descriptor.
   * @deprecated Use `api.session.controls.registerControlUiDescriptor(...)`.
   */
  registerControlUiDescriptor: (descriptor: PluginControlUiDescriptor) => void;
  /**
   * Register cleanup hooks for plugin-owned host state and background work.
   * @deprecated Use `api.lifecycle.registerRuntimeLifecycle(...)`.
   */
  registerRuntimeLifecycle: (lifecycle: PluginRuntimeLifecycleRegistration) => void;
  /**
   * Subscribe to sanitized agent events through the host-owned plugin lifecycle.
   * @deprecated Use `api.agent.events.registerAgentEventSubscription(...)`.
   */
  registerAgentEventSubscription: (subscription: PluginAgentEventSubscriptionRegistration) => void;
  /**
   * Emit a host-routed, plugin-attributed agent event for workflow/UI subscribers.
   * @deprecated Use `api.agent.events.emitAgentEvent(...)`.
   */
  emitAgentEvent: (params: PluginAgentEventEmitParams) => PluginAgentEventEmitResult;
  /**
   * Store namespaced, JSON-compatible data for the active run. Cleared on run end/error.
   * @deprecated Use `api.runContext.setRunContext(...)`.
   */
  setRunContext: (patch: PluginRunContextPatch) => boolean;
  /**
   * Read namespaced plugin data for a run.
   * @deprecated Use `api.runContext.getRunContext(...)`.
   */
  getRunContext: (params: PluginRunContextGetParams) => PluginJsonValue | undefined;
  /**
   * Clear one namespace or all namespaces this plugin owns for a run.
   * @deprecated Use `api.runContext.clearRunContext(...)`.
   */
  clearRunContext: (params: {
    runId: string;
    namespace?: string;
  }) => void;
  /**
   * Register cleanup metadata for a plugin-owned session scheduler job.
   * This does not schedule work or create task records; it only lets the host
   * clean external scheduler state during reset/delete/disable.
   *
   * @deprecated Use `api.session.workflow.registerSessionSchedulerJob(...)`.
   */
  registerSessionSchedulerJob: (job: PluginSessionSchedulerJobRegistration) => PluginSessionSchedulerJobHandle | undefined;
  /**
   * Register a typed session action that clients can dispatch through the Gateway.
   * @deprecated Use `api.session.controls.registerSessionAction(...)`.
   */
  registerSessionAction: (action: PluginSessionActionRegistration) => void;
  /**
   * Send one or more host-validated files to the active direct-outbound channel for a session.
   *
   * This API is intended for bundled plugins running with the host channel/session
   * integration available. Calls may resolve to `{ ok: false }` instead of attaching
   * files when global side effects are disabled or when the required plugin/channel
   * runtime is not loaded, so callers must handle rejection via the returned result.
   *
   * @deprecated Use `api.session.workflow.sendSessionAttachment(...)`.
   */
  sendSessionAttachment: (params: PluginSessionAttachmentParams) => Promise<PluginSessionAttachmentResult>;
  /**
   * Schedule a future agent turn in a session through Cron.
   * Cron owns timing and creates the task ledger entry when the turn runs.
   * Bundled plugins only; workspace plugins receive undefined.
   *
   * @deprecated Use `api.session.workflow.scheduleSessionTurn(...)`.
   */
  scheduleSessionTurn: (params: PluginSessionTurnScheduleParams) => Promise<PluginSessionSchedulerJobHandle | undefined>;
  /**
   * Remove Cron-backed scheduled session turns that share the same plugin-owned tag.
   * Bundled plugins only; workspace plugins receive a zero-count result.
   *
   * @deprecated Use `api.session.workflow.unscheduleSessionTurnsByTag(...)`.
   */
  unscheduleSessionTurnsByTag: (params: PluginSessionTurnUnscheduleByTagParams) => Promise<PluginSessionTurnUnscheduleByTagResult>; /** Register the active detached task runtime for this plugin (exclusive slot). */
  registerDetachedTaskRuntime: (runtime: DetachedTaskLifecycleRuntime) => void; /** Register the active memory capability for this memory plugin (exclusive slot). */
  registerMemoryCapability: (capability: MemoryPluginCapability) => void;
  /**
   * Register the system prompt section builder for this memory plugin (exclusive slot).
   * @deprecated Use registerMemoryCapability({ promptBuilder }) instead.
   */
  registerMemoryPromptSection: (builder: MemoryPromptSectionBuilder) => void; /** Register an additive memory-adjacent prompt section (non-exclusive). */
  registerMemoryPromptSupplement: (builder: MemoryPromptSectionBuilder) => void; /** Register an additive memory-adjacent search/read corpus supplement (non-exclusive). */
  registerMemoryCorpusSupplement: (supplement: MemoryCorpusSupplement) => void;
  /**
   * Register the pre-compaction flush plan resolver for this memory plugin (exclusive slot).
   * @deprecated Use registerMemoryCapability({ flushPlanResolver }) instead.
   */
  registerMemoryFlushPlan: (resolver: MemoryFlushPlanResolver) => void;
  /**
   * Register the active memory runtime adapter for this memory plugin (exclusive slot).
   * @deprecated Use registerMemoryCapability({ runtime }) instead.
   */
  registerMemoryRuntime: (runtime: MemoryPluginRuntime) => void; /** Register a memory embedding provider adapter. Multiple adapters may coexist. */
  registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
  resolvePath: (input: string) => string; /** Register a lifecycle hook handler */
  on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: {
    priority?: number;
    timeoutMs?: number;
  }) => void;
};
//#endregion
export { OpenClawPluginService as $, ProviderExternalAuthProfile as $n, RealtimeTranscriptionProviderConfig as $r, ProviderModernModelPolicyContext as $t, OpenClawPluginDefinition as A, isToolWrappedWithBeforeToolCallHook as Ai, ProviderResolveTransportTurnStateContext as An, AgentToolResultMiddlewareResult as Ar, ProviderAuthResult as At, OpenClawPluginModule as B, MemoryEmbeddingProviderCallOptions as Bi, ProviderValidateReplayTurnsContext as Bn, RealtimeVoiceBridgeEvent as Br, ProviderCreateEmbeddingProviderContext as Bt, OpenClawPluginApi as C, NormalizedUsage as Ci, ProviderReplaySessionEntry as Cn, PluginTextReplacement as Cr, ProviderAugmentModelCatalogContext as Ct, OpenClawPluginCliRegistrar as D, HookContext as Di, ProviderResolveDynamicModelContext as Dn, AgentToolResultMiddlewareEvent as Dr, ProviderAuthMethod as Dt, OpenClawPluginCliContext as E, BuildAgentRuntimePlanParams as Ei, ProviderResolveAuthProfileIdContext as En, AgentToolResultMiddlewareContext as Er, ProviderAuthKind as Et, OpenClawPluginHttpRouteHandler as F, resolveEmbeddedAgentRuntime as Fi, ProviderSanitizeReplayHistoryContext as Fn, RealtimeVoiceAudioFormat as Fr, ProviderCacheTtlEligibilityContext as Ft, OpenClawPluginNodeInvokePolicyApprovalRuntime as G, listRegisteredMemoryEmbeddingProviders as Gi, SpeechProviderPlugin as Gn, RealtimeVoiceProviderConfig as Gr, ProviderDiscoveryResult as Gt, OpenClawPluginNodeHostCommand as H, MemoryEmbeddingProviderCreateResult as Hi, ProviderWrapStreamFnContext as Hn, RealtimeVoiceBrowserSessionCreateRequest as Hr, ProviderDeferSyntheticProfileAuthContext as Ht, OpenClawPluginHttpRouteMatch as I, MemoryEmbeddingBatchChunk as Ii, ProviderSystemPromptContributionContext as In, RealtimeVoiceBargeInOptions as Ir, ProviderCapabilities as It, OpenClawPluginNodeInvokeTransportResult as J, VideoGenerationProviderPlugin as Jn, RealtimeVoiceProviderResolveConfigContext as Jr, ProviderFailoverErrorContext as Jt, OpenClawPluginNodeInvokePolicyContext as K, registerMemoryEmbeddingProvider as Ki, UnifiedModelCatalogProviderContext as Kn, RealtimeVoiceProviderConfiguredContext as Kr, ProviderExtraParamsForTransportContext as Kt, OpenClawPluginHttpRouteParams as L, MemoryEmbeddingBatchOptions as Li, ProviderToolSchemaDiagnostic as Ln, RealtimeVoiceBridge as Lr, ProviderCatalogContext as Lt, OpenClawPluginGatewayRuntimeScopeSurface as M, setBeforeToolCallDiagnosticsEnabled as Mi, ProviderResolveWebSocketSessionPolicyContext as Mn, OpenClawAgentToolResult as Mr, ProviderBuildUnknownModelHintContext as Mt, OpenClawPluginHostedMediaResolver as N, wrapToolWithBeforeToolCallHook as Ni, ProviderResolvedUsageAuth as Nn, REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ as Nr, ProviderBuiltInModelSuppressionContext as Nt, OpenClawPluginCommandDefinition as O, ToolOutcomeObserver as Oi, ProviderResolveNonInteractiveApiKeyParams as On, AgentToolResultMiddlewareHarness as Or, ProviderAuthMethodNonInteractiveContext as Ot, OpenClawPluginHttpRouteAuth as P, AgentHarnessTaskRuntimeScope as Pi, ProviderRuntimeProviderConfig as Pn, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ as Pr, ProviderBuiltInModelSuppressionResult as Pt, OpenClawPluginSecurityAuditContext as Q, ProviderRuntimeModel as Qn, RealtimeVoiceToolResultOptions as Qr, ProviderModelSelectedContext as Qt, OpenClawPluginHttpRouteUpgradeHandler as R, MemoryEmbeddingProvider as Ri, ProviderTransformSystemPromptContext as Rn, RealtimeVoiceBridgeCallbacks as Rr, ProviderCatalogOrder as Rt, OpenClawPluginAgentEventsApi as S, PreemptiveCompactionRoute as Si, ProviderReplaySanitizeMode as Sn, CliBundleMcpMode as Sr, PluginTextTransformRegistration as St, OpenClawPluginCliCommandDescriptor as T, AgentRuntimePlan as Ti, ProviderReplayToolCallIdMode as Tn, AgentToolResultMiddleware as Tr, ProviderAuthDoctorHintContext as Tt, OpenClawPluginNodeInvokeApprovalDecision as U, MemoryEmbeddingProviderRuntime as Ui, RealtimeTranscriptionProviderPlugin as Un, RealtimeVoiceCloseReason as Ur, ProviderDiscoveryContext as Ut, OpenClawPluginNodeCliFeatureOptions as V, MemoryEmbeddingProviderCreateOptions as Vi, ProviderWebSocketSessionPolicy as Vn, RealtimeVoiceBrowserSession as Vr, ProviderCreateStreamFnContext as Vt, OpenClawPluginNodeInvokePolicy as W, clearMemoryEmbeddingProviders as Wi, RealtimeVoiceProviderPlugin as Wn, RealtimeVoiceProviderCapabilities as Wr, ProviderDiscoveryOrder as Wt, OpenClawPluginRunContextApi as X, ProviderThinkingPolicyContext as Xn, RealtimeVoiceTool as Xr, ProviderFollowupFallbackRouteContext as Xt, OpenClawPluginReloadRegistration as Y, ProviderDefaultThinkingPolicyContext as Yn, RealtimeVoiceRole as Yr, ProviderFetchUsageSnapshotContext as Yt, OpenClawPluginSecurityAuditCollector as Z, ProviderThinkingProfile as Zn, RealtimeVoiceToolCallEvent as Zr, ProviderFollowupFallbackRouteResult as Zt, MigrationSummary as _, AgentHarnessSupport as _i, ProviderPreparedRuntimeAuth as _n, CliBackendPrepareExecutionContext as _r, PluginRealtimeVoiceProviderEntry as _t, ImageGenerationProviderPlugin as a, RealtimeTranscriptionSessionCreateRequest as ai, ProviderNormalizeTransportContext as an, ProviderApplyConfigDefaultsContext as ar, PluginCommandContext as at, OpenClawGatewayDiscoveryService as b, EmbeddedRunAttemptParams as bi, ProviderReplayPolicy as bn, CliBackendResolveExecutionArgsContext as br, PluginSetupAutoEnableProbe as bt, MigrationDetection as c, AgentHarnessAttemptParams as ci, ProviderPluginCatalog as cn, CodexAppServerExtensionContext as cr, PluginCommandResult as ct, MigrationItemKind as d, AgentHarnessCompactResult as di, ProviderPluginWizardModelPicker as dn, CodexAppServerToolResultEvent as dr, PluginEmbeddingProvider as dt, RealtimeTranscriptionProviderConfiguredContext as ei, ProviderNonInteractiveApiKeyCredentialParams as en, ProviderExternalOAuthProfile as er, OpenClawPluginServiceContext as et, MigrationItemStatus as f, AgentHarnessDeliveryDefaults as fi, ProviderPluginWizardSetup as fn, CodexAppServerToolResultHandlerResult as fr, PluginInteractiveHandlerRegistration as ft, MigrationProviderPreparation as g, AgentHarnessSideQuestionResult as gi, ProviderPrepareRuntimeAuthContext as gn, CliBackendPlugin as gr, PluginRealtimeTranscriptionProviderEntry as gt, MigrationProviderPlugin as h, AgentHarnessSideQuestionParams as hi, ProviderPrepareExtraParamsContext as hn, CliBackendNormalizeConfigContext as hr, PluginLogger as ht, AgentPromptSurfaceKind as i, RealtimeTranscriptionSessionCallbacks as ii, ProviderNormalizeToolSchemasContext as in, ProviderSyntheticAuthResult as ir, OpenClawPluginSessionWorkflowApi as it, OpenClawPluginGatewayMethod as j, runBeforeToolCallHook as ji, ProviderResolveUsageAuthContext as jn, AgentToolResultMiddlewareRuntime as jr, ProviderBuildMissingAuthMessageContext as jt, OpenClawPluginConfigSchema as k, hasBeforeToolCallPolicy as ki, ProviderResolvePromptOverlayContext as kn, AgentToolResultMiddlewareOptions as kr, ProviderAuthOptionBag as kt, MigrationItem as l, AgentHarnessAttemptResult as li, ProviderPluginDiscovery as ln, CodexAppServerExtensionFactory as lr, PluginConfigMigration as lt, MigrationProviderContext as m, AgentHarnessResultClassification as mi, ProviderPrepareDynamicModelContext as mn, CliBackendNativeToolMode as mr, PluginInteractiveRegistration as mt, AgentPromptGuidance as n, RealtimeTranscriptionProviderResolveConfigContext as ni, ProviderNormalizeModelIdContext as nn, ProviderResolveExternalOAuthProfilesContext as nr, OpenClawPluginSessionControlsApi as nt, MediaUnderstandingProviderPlugin as o, ProviderSystemPromptContribution as oi, ProviderOAuthProfileIdRepair as on, ProviderNormalizeConfigContext as or, PluginCommandDiagnosticsSession as ot, MigrationPlan as p, AgentHarnessResetParams as pi, ProviderPreferRuntimeResolvedModelContext as pn, CliBackendAuthEpochMode as pr, PluginInteractiveHandlerResult as pt, OpenClawPluginNodeInvokePolicyResult as q, UnifiedModelCatalogProviderPlugin as qn, RealtimeVoiceProviderId as qr, ProviderExtraParamsForTransportResult as qt, AgentPromptGuidanceEntry as r, RealtimeTranscriptionSession as ri, ProviderNormalizeResolvedModelContext as rn, ProviderResolveSyntheticAuthContext as rr, OpenClawPluginSessionStateApi as rt, MigrationApplyResult as s, AgentHarness as si, ProviderPlugin as sn, ProviderResolveConfigApiKeyContext as sr, PluginCommandHandler as st, AGENT_PROMPT_SURFACE_KINDS as t, RealtimeTranscriptionProviderId as ti, ProviderNonInteractiveApiKeyResult as tn, ProviderResolveExternalAuthProfilesContext as tr, OpenClawPluginSessionApi as tt, MigrationItemAction as u, AgentHarnessCompactParams as ui, ProviderPluginWizard as un, CodexAppServerExtensionRuntime as ur, PluginConfigValidation as ut, MusicGenerationProviderPlugin as v, AgentHarnessSupportContext as vi, ProviderReasoningOutputMode as vn, CliBackendPreparedExecution as vr, PluginRegistrationMode as vt, OpenClawPluginChannelRegistration as w, normalizeUsage as wi, ProviderReplaySessionState as wn, PluginTextTransforms as wr, ProviderAuthContext as wt, OpenClawPluginAgentApi as x, EmbeddedRunAttemptResult as xi, ProviderReplayPolicyContext as xn, CliBackendThinkingLevel as xr, PluginSpeechProviderEntry as xt, OpenClawGatewayDiscoveryAdvertiseContext as y, CompactEmbeddedPiSessionParams as yi, ProviderReasoningOutputModeContext as yn, CliBackendResolveExecutionArgs as yr, PluginSetupAutoEnableContext as yt, OpenClawPluginLifecycleApi as z, MemoryEmbeddingProviderAdapter as zi, ProviderTransportTurnState as zn, RealtimeVoiceBridgeCreateRequest as zr, ProviderCatalogResult as zt };