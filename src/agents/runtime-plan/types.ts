import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { ProviderFollowupFallbackRoute } from "../../plugins/types.js";
import type { SupportedTransport } from "../pi-embedded-runner/extra-params.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
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
};

export type AgentRuntimeToolPlan = {
  normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
    tools: AgentTool<TSchemaType, TResult>[],
  ): AgentTool<TSchemaType, TResult>[];
  logDiagnostics(tools: AgentTool[]): void;
};

export type AgentRuntimeDeliveryPlan = {
  isSilentPayload(payload: Pick<ReplyPayload, "text" | "mediaUrl" | "mediaUrls">): boolean;
  resolveFollowupRoute(params: {
    payload: ReplyPayload;
    originatingChannel?: string;
    originatingTo?: string;
    originRoutable: boolean;
    dispatcherAvailable: boolean;
  }): ProviderFollowupFallbackRoute | undefined;
};

export type AgentRuntimeOutcomePlan = {
  classifyRunResult(
    result: EmbeddedPiRunResult,
  ): ReturnType<
    typeof import("../pi-embedded-runner/result-fallback-classifier.js").classifyEmbeddedPiRunResultForModelFallback
  >;
};

export type AgentRuntimeTransportPlan = {
  extraParams: Record<string, unknown>;
};

export type AgentRuntimePlan = {
  resolvedRef: AgentRuntimeResolvedRef;
  auth: AgentRuntimeAuthPlan;
  prompt: AgentRuntimePromptPlan;
  tools: AgentRuntimeToolPlan;
  transcript: { policy: TranscriptPolicy };
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
  authProfileProvider?: string;
  sessionAuthProfileId?: string;
  agentId?: string;
  thinkingLevel?: ThinkLevel;
  extraParamsOverride?: Record<string, unknown>;
  resolvedTransport?: SupportedTransport;
};
