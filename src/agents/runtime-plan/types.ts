import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type {
  ProviderFollowupFallbackRouteResult,
  ProviderSystemPromptContributionContext,
} from "../../plugins/types.js";
import type { SupportedTransport } from "../pi-embedded-runner/extra-params.js";
import type { classifyEmbeddedPiRunResultForModelFallback } from "../pi-embedded-runner/result-fallback-classifier.js";
import type { ProviderSystemPromptContribution } from "../system-prompt-contribution.js";
import type { TranscriptPolicy } from "../transcript-policy.js";

export type AgentRuntimeResolvedRef = {
  provider: string;
  modelId: string;
  modelApi?: string;
  harnessId?: string;
  transport?: SupportedTransport;
};

export type AgentRuntimeAuthPlan = {
  providerForAuth: string;
  authProfileProviderForAuth: string;
  harnessAuthProvider?: string;
  forwardedAuthProfileId?: string;
};

export type AgentRuntimePromptPlan = {
  provider: string;
  modelId: string;
  resolveSystemPromptContribution(
    context: ProviderSystemPromptContributionContext,
  ): ProviderSystemPromptContribution | undefined;
};

export type AgentRuntimeToolPlan = {
  normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
    tools: AgentTool<TSchemaType, TResult>[],
    params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: ProviderRuntimeModel;
    },
  ): AgentTool<TSchemaType, TResult>[];
  logDiagnostics(
    tools: AgentTool[],
    params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: ProviderRuntimeModel;
    },
  ): void;
};

export type AgentRuntimeDeliveryPlan = {
  isSilentPayload(payload: Pick<ReplyPayload, "text" | "mediaUrl" | "mediaUrls">): boolean;
  resolveFollowupRoute(params: {
    payload: ReplyPayload;
    originatingChannel?: string;
    originatingTo?: string;
    originRoutable: boolean;
    dispatcherAvailable: boolean;
  }): ProviderFollowupFallbackRouteResult | undefined;
};

export type AgentRuntimeOutcomePlan = {
  classifyRunResult: typeof classifyEmbeddedPiRunResultForModelFallback;
};

export type AgentRuntimeTransportPlan = {
  extraParams: Record<string, unknown>;
  resolveExtraParams(params?: {
    extraParamsOverride?: Record<string, unknown>;
    thinkingLevel?: ThinkLevel;
    agentId?: string;
    workspaceDir?: string;
    model?: ProviderRuntimeModel;
    resolvedTransport?: SupportedTransport;
  }): Record<string, unknown>;
};

export type AgentRuntimePlan = {
  resolvedRef: AgentRuntimeResolvedRef;
  auth: AgentRuntimeAuthPlan;
  prompt: AgentRuntimePromptPlan;
  tools: AgentRuntimeToolPlan;
  transcript: {
    policy: TranscriptPolicy;
    resolvePolicy(params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: ProviderRuntimeModel;
    }): TranscriptPolicy;
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
    transport?: SupportedTransport;
  };
};

export type BuildAgentRuntimeDeliveryPlanParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
};

export type BuildAgentRuntimePlanParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  modelApi?: string | null;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
  authProfileProvider?: string;
  sessionAuthProfileId?: string;
  agentId?: string;
  thinkingLevel?: ThinkLevel;
  extraParamsOverride?: Record<string, unknown>;
  resolvedTransport?: SupportedTransport;
};
