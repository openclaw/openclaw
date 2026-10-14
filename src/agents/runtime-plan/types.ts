import type { TSchema } from "typebox";
import type {
  ModelApi,
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "../../plugin-sdk/provider-model-types.js";
import type { ReplyPayload as AgentRuntimeReplyPayload } from "../../shared/reply-payload.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import type { ProviderModelAuthSourceClassification } from "../provider-model-auth-source-plan.js";
import type { EmbeddedRunTrigger } from "../run-trigger.js";
import type { AgentTool } from "../runtime/index.js";
import type { ProviderSystemPromptContribution } from "../system-prompt-contribution.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";

export type AgentRuntimeTransport = "sse" | "websocket" | "websocket-cached" | "auto";

type AgentRuntimeThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

type AgentRuntimePromptMode = "full" | "minimal" | "none";

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
  modelId?: string | null;
  config?: unknown;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
};

type PreparedAgentRuntimeProviderHandle = AgentRuntimeProviderHandle & {
  modelId: string | null;
  prepared: true;
};

type AgentRuntimeSystemPromptContributionContext = {
  config?: unknown;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  promptMode: AgentRuntimePromptMode;
  runtimeChannel?: string;
  runtimeCapabilities?: string[];
  agentId?: string;
  trigger?: EmbeddedRunTrigger;
};

type AgentRuntimeFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};

type AgentRuntimeOutcomeClassifier = (params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}) => ModelFallbackResultClassification;

type AgentRuntimeResolvedRef = {
  provider: string;
  modelId: string;
  modelApi?: string;
  harnessId?: string;
  transport?: AgentRuntimeTransport;
};

export type AgentRuntimeAuthModelRoute = {
  provider: string;
  modelId: string;
  api: ModelApi;
  baseUrl: string;
  authRequirement: "api-key" | "subscription";
  /** Secret-free request behavior that the selected runtime must reproduce. */
  requestTransportOverrides: ProviderRouteOverridePresence;
  /** Provider-owned native-runtime compatibility for this concrete route. */
  runtimePolicy?: ProviderModelRouteRuntimePolicy;
};

/** Common native-runtime support proven across every route left to the harness. */
type AgentRuntimeAuthDeferredRouteSupport = {
  requestTransportOverrides: ProviderRouteOverridePresence;
  runtimePolicy: ProviderModelRouteRuntimePolicy;
};

export type AgentRuntimeCredentialSource = ProviderModelAuthSourceClassification | { kind: "none" };

/** Actual provider/model/source tuple owned by one physical model attempt. */
export type AgentRuntimeModelAttempt = {
  provider: string;
  model: string;
  credentialSource: AgentRuntimeCredentialSource;
};

export type AgentRuntimeAuthPlan = {
  providerForAuth: string;
  /** Model whose order, cooldown, and route facts produced this plan. */
  modelId?: string;
  authProfileProviderForAuth: string;
  harnessAuthProvider?: string;
  /** Preferred or user-locked profile; automatic selection may not have resolved its secret yet. */
  forwardedAuthProfileId?: string;
  forwardedAuthProfileSource?: "auto" | "user";
  /** Ordered exhaustive candidates for the selected route; a singleton is terminal. */
  forwardedAuthProfileCandidateIds?: string[];
  /** Exact selected credential/config mode; secret-free route materialization input. */
  selectedAuthMode?: string;
  selectedAuthFlow?: string;
  /** Concrete provider-owned route selected before runtime dispatch. */
  modelRoute?: AgentRuntimeAuthModelRoute;
  /** Secret-free support shared by every route deferred to harness-owned auth. */
  deferredRouteSupport?: AgentRuntimeAuthDeferredRouteSupport;
  /** Redacted source selected for this concrete physical attempt. */
  credentialSource?: AgentRuntimeCredentialSource;
};

type AgentRuntimePromptPlan = {
  provider: string;
  modelId: string;
  textTransforms?: AgentRuntimeTextTransforms;
  resolveSystemPromptContribution(
    context: AgentRuntimeSystemPromptContributionContext,
  ): ProviderSystemPromptContribution | undefined;
  transformSystemPrompt(
    context: AgentRuntimeSystemPromptContributionContext & {
      systemPrompt: string;
    },
  ): string;
};

/** Prepared plugin metadata snapshot kept opaque to runtime-plan consumers. */
type AgentRuntimePreparedMetadataSnapshot = object;

/** Prepared metadata loader used by tool planning without eager manifest reads. */
type PreparedOpenClawToolPlanning = {
  metadataSnapshot?: AgentRuntimePreparedMetadataSnapshot;
};

type AgentRuntimeModelOverrides = {
  workspaceDir?: string;
  modelApi?: string;
  model?: AgentRuntimeModel;
};

type AgentRuntimeToolPlan = {
  preparedPlanning?: PreparedOpenClawToolPlanning;
  normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
    tools: AgentTool<TSchemaType, TResult>[],
    params?: AgentRuntimeModelOverrides,
  ): AgentTool<TSchemaType, TResult>[];
  logDiagnostics(tools: AgentTool[], params?: AgentRuntimeModelOverrides): void;
};

export type AgentRuntimeDeliveryPlan = {
  isSilentPayload(
    payload: Pick<
      AgentRuntimeReplyPayload,
      "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData"
    >,
  ): boolean;
  resolveFollowupRoute(params: {
    payload: AgentRuntimeReplyPayload;
    originatingChannel?: string;
    originatingTo?: string;
    originRoutable: boolean;
    dispatcherAvailable: boolean;
  }): AgentRuntimeFollowupFallbackRouteResult | undefined;
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

export type AgentRuntimePlan = {
  resolvedRef: AgentRuntimeResolvedRef;
  providerRuntimeHandle?: PreparedAgentRuntimeProviderHandle;
  auth: AgentRuntimeAuthPlan;
  prompt: AgentRuntimePromptPlan;
  tools: AgentRuntimeToolPlan;
  transcript: {
    policy: TranscriptPolicy;
    resolvePolicy(
      params?: AgentRuntimeModelOverrides & { directApiKey?: boolean },
    ): TranscriptPolicy;
  };
  delivery: AgentRuntimeDeliveryPlan;
  outcome: { classifyRunResult: AgentRuntimeOutcomeClassifier };
  transport: AgentRuntimeTransportPlan;
  observability: AgentRuntimeResolvedRef & {
    resolvedRef: string;
    authProfileId?: string;
  };
};

export type BuildAgentRuntimeDeliveryPlanParams = {
  config?: unknown;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  providerRuntimeHandle?: PreparedAgentRuntimeProviderHandle;
};

export type BuildAgentRuntimePlanParams = BuildAgentRuntimeDeliveryPlanParams & {
  model?: AgentRuntimeModel;
  modelApi?: string | null;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
  /** Canonical route/auth decision prepared before attempt orchestration. */
  preparedAuthPlan?: AgentRuntimeAuthPlan;
  authProfileProvider?: string;
  authProfileMode?: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user" | "user-link";
  sessionAuthProfileCandidateIds?: string[];
  authProfileStore?: AuthProfileStore;
  modelRoute?: AgentRuntimeAuthModelRoute;
  agentId?: string;
  thinkingLevel?: AgentRuntimeThinkLevel;
  extraParamsOverride?: Record<string, unknown>;
  resolvedTransport?: AgentRuntimeTransport;
  /** Omit only when a standalone caller intentionally resolves provider hooks lazily. */
  providerRuntimeHandle?: PreparedAgentRuntimeProviderHandle;
  /** Lifecycle-owned plugin metadata prepared before the attempt starts. */
  metadataSnapshot?: AgentRuntimePreparedMetadataSnapshot;
};
