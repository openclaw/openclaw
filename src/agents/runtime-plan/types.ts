import type { TSchema } from "typebox";
import type { AgentTool } from "../runtime/index.js";

export type AgentRuntimeTransport = "sse" | "websocket" | "auto";

export type AgentRuntimeThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export type AgentRuntimePromptMode = "full" | "minimal" | "none";
export type AgentRuntimePromptTrigger =
  | "cron"
  | "heartbeat"
  | "manual"
  | "memory"
  | "overflow"
  | "user";

export type AgentRuntimeFailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "server_error"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";

export type AgentRuntimeConfig = unknown;

export type AgentRuntimeModel = {
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

export type AgentRuntimeTextReplacement = {
  from: string | RegExp;
  to: string;
};

export type AgentRuntimeTextTransforms = {
  input?: AgentRuntimeTextReplacement[];
  output?: AgentRuntimeTextReplacement[];
};

export type AgentRuntimeProviderHandle = {
  provider: string;
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderVitestCompat?: boolean;
};

export type AgentRuntimeInteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

export type AgentRuntimeMessagePresentationAction =
  | {
      type: "command";
      command: string;
    }
  | {
      type: "callback";
      value: string;
    };

/** Portable action control exposed to agent runtime reply payloads. */
export type AgentRuntimeMessagePresentationButton = {
  /** User-visible button label. */
  label: string;
  /** Typed action sent when pressed. */
  action?: AgentRuntimeMessagePresentationAction;
  /** Legacy opaque callback value sent when pressed. */
  value?: string;
  /** External URL opened by the button. */
  url?: string;
  /** Channel-native web app URL for renderers that support embedded web apps. */
  webApp?: { url: string };
  /** Higher values are kept first when channel action limits require dropping controls. */
  priority?: number;
  /** Disabled action hint; channels without disabled-state support render fallback text. */
  disabled?: boolean;
  /** Optional visual style hint for renderers that support styled actions. */
  style?: AgentRuntimeInteractiveButtonStyle;
};

/** Portable select/menu option exposed to agent runtime reply payloads. */
export type AgentRuntimeMessagePresentationOption = {
  /** User-visible option label. */
  label: string;
  /** Typed action sent when selected. */
  action?: AgentRuntimeMessagePresentationAction;
  /** Legacy opaque callback value sent when selected. */
  value?: string;
};

/**
 * @deprecated Use AgentRuntimeMessagePresentationButton.
 */
export type AgentRuntimeInteractiveReplyButton = AgentRuntimeMessagePresentationButton;

/**
 * @deprecated Use AgentRuntimeMessagePresentationOption.
 */
export type AgentRuntimeInteractiveReplyOption = AgentRuntimeMessagePresentationOption;

/**
 * @deprecated Use AgentRuntimeMessagePresentationBlock.
 */
export type AgentRuntimeInteractiveReplyBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "buttons";
      buttons: AgentRuntimeInteractiveReplyButton[];
    }
  | {
      type: "select";
      placeholder?: string;
      options: AgentRuntimeInteractiveReplyOption[];
    };

/**
 * @deprecated Use AgentRuntimeMessagePresentation.
 */
export type AgentRuntimeInteractiveReply = {
  blocks: AgentRuntimeInteractiveReplyBlock[];
};

export type AgentRuntimeMessagePresentationTone =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export type AgentRuntimeMessagePresentationBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "context";
      text: string;
    }
  | {
      type: "divider";
    }
  | {
      type: "buttons";
      buttons: AgentRuntimeMessagePresentationButton[];
    }
  | {
      type: "select";
      placeholder?: string;
      options: AgentRuntimeMessagePresentationOption[];
    };

export type AgentRuntimeMessagePresentation = {
  /** Optional short heading rendered before blocks when supported. */
  title?: string;
  /** Optional severity/status tone for renderers that support toned presentations. */
  tone?: AgentRuntimeMessagePresentationTone;
  /** Ordered portable blocks rendered or downgraded by channel adapters. */
  blocks: AgentRuntimeMessagePresentationBlock[];
};

export type AgentRuntimeReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};

export type AgentRuntimeReplyPayloadDelivery = {
  pin?: boolean | AgentRuntimeReplyPayloadDeliveryPin;
};

export type AgentRuntimeReplyPayload = {
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
  isReasoningSnapshot?: boolean;
  isCompactionNotice?: boolean;
  isFallbackNotice?: boolean;
  isStatusNotice?: boolean;
  channelData?: Record<string, unknown>;
};

export type AgentRuntimeSystemPromptSectionId =
  | "interaction_style"
  | "tool_call_style"
  | "execution_bias";

export type AgentRuntimeSystemPromptContribution = {
  stablePrefix?: string;
  dynamicSuffix?: string;
  sectionOverrides?: Partial<Record<AgentRuntimeSystemPromptSectionId, string>>;
};

export type AgentRuntimeSystemPromptContributionContext = {
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

export type AgentRuntimeFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};

export type AgentRuntimeToolCallIdMode = "strict" | "strict9";

export type AgentRuntimeTranscriptPolicy = {
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

export type AgentRuntimeOutcomeClassification =
  | {
      message: string;
      reason?: AgentRuntimeFailoverReason;
      status?: number;
      code?: string;
      rawError?: string;
    }
  | {
      error: unknown;
    }
  | null
  | undefined;

export type AgentRuntimeOutcomeClassifier = (params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}) => AgentRuntimeOutcomeClassification;

export type AgentRuntimeResolvedRef = {
  provider: string;
  modelId: string;
  modelApi?: string;
  harnessId?: string;
  transport?: AgentRuntimeTransport;
};

export type AgentRuntimeAuthPlan = {
  /** Provider id after plugin auth-alias resolution for the requested runtime provider. */
  providerForAuth: string;
  /** Provider id that owns the selected auth profile after auth-alias resolution. */
  authProfileProviderForAuth: string;
  /** Harness-owned auth provider used when a wrapper runtime forwards another provider's profile. */
  harnessAuthProvider?: string;
  /** Session auth profile forwarded only when runtime/harness provider ownership matches. */
  forwardedAuthProfileId?: string;
  /** Candidate profile ids forwarded with the selected profile for provider-side fallback. */
  forwardedAuthProfileCandidateIds?: string[];
};

export type AgentRuntimePromptPlan = {
  provider: string;
  modelId: string;
  textTransforms?: AgentRuntimeTextTransforms;
  resolveSystemPromptContribution(
    context: AgentRuntimeSystemPromptContributionContext,
  ): AgentRuntimeSystemPromptContribution | undefined;
  transformSystemPrompt(
    context: AgentRuntimeSystemPromptContributionContext & {
      systemPrompt: string;
    },
  ): string;
};

// Keep the leaf runtime-plan contract decoupled from plugin metadata internals.
export type AgentRuntimePreparedMetadataSnapshot = object;

export type PreparedOpenClawToolPlanning = {
  /** Already materialized plugin metadata snapshot for tool planning callers that prepared it earlier. */
  metadataSnapshot?: AgentRuntimePreparedMetadataSnapshot;
  /** Lazy snapshot loader so hot paths do not read plugin metadata unless planning needs it. */
  loadMetadataSnapshot?: () => AgentRuntimePreparedMetadataSnapshot;
};

export type AgentRuntimeToolPlan = {
  /** Shared planning inputs passed to OpenClaw-owned tools without coupling callers to plugin internals. */
  preparedPlanning?: PreparedOpenClawToolPlanning;
  /** Normalize tool schemas for the provider/model currently driving the runtime plan. */
  normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
    tools: AgentTool<TSchemaType, TResult>[],
    params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: AgentRuntimeModel;
    },
  ): AgentTool<TSchemaType, TResult>[];
  /** Emit provider/model-specific diagnostics for the already selected tool set. */
  logDiagnostics(
    tools: AgentTool[],
    params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: AgentRuntimeModel;
    },
  ): void;
};

export type AgentRuntimeDeliveryPlan = {
  /** Detect payloads intentionally used as channel-control silence markers. */
  isSilentPayload(
    payload: Pick<
      AgentRuntimeReplyPayload,
      "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData"
    >,
  ): boolean;
  /** Decide where provider fallback follow-up text should be delivered, if anywhere. */
  resolveFollowupRoute(params: {
    payload: AgentRuntimeReplyPayload;
    originatingChannel?: string;
    originatingTo?: string;
    originRoutable: boolean;
    dispatcherAvailable: boolean;
  }): AgentRuntimeFollowupFallbackRouteResult | undefined;
};

export type AgentRuntimeOutcomePlan = {
  /** Classify provider run results into normalized failover reasons. */
  classifyRunResult: AgentRuntimeOutcomeClassifier;
};

export type AgentRuntimeTransportPlan = {
  /** Default transport extra params for the resolved model/provider pair. */
  extraParams: Record<string, unknown>;
  /** Recompute transport extra params for an override context without rebuilding the whole plan. */
  resolveExtraParams(params?: {
    extraParamsOverride?: Record<string, unknown>;
    thinkingLevel?: AgentRuntimeThinkLevel;
    agentId?: string;
    workspaceDir?: string;
    model?: AgentRuntimeModel;
    resolvedTransport?: AgentRuntimeTransport;
  }): Record<string, unknown>;
};

export type AgentRuntimePlan = {
  /** Stable provider/model/harness/transport identity for this runtime plan. */
  resolvedRef: AgentRuntimeResolvedRef;
  /** Provider plugin handle resolved once and shared by plan subsystems. */
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
  auth: AgentRuntimeAuthPlan;
  prompt: AgentRuntimePromptPlan;
  tools: AgentRuntimeToolPlan;
  transcript: {
    /** Lazily resolved default transcript policy for the plan's base context. */
    policy: AgentRuntimeTranscriptPolicy;
    /** Resolve transcript policy for a workspace/model override context. */
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
    /** Compact provider/model ref used in logs and diagnostics. */
    resolvedRef: string;
    provider: string;
    modelId: string;
    modelApi?: string;
    harnessId?: string;
    authProfileId?: string;
    transport?: AgentRuntimeTransport;
  };
};

export type BuildAgentRuntimeDeliveryPlanParams = {
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
};

export type BuildAgentRuntimePlanParams = {
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
