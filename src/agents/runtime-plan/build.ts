import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { TSchema } from "typebox";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { resolveProviderFollowupFallbackRoute } from "../../plugins/provider-runtime.js";
import {
  resolvePreparedExtraParams,
  type SupportedTransport,
} from "../pi-embedded-runner/extra-params.js";
import { classifyEmbeddedPiRunResultForModelFallback } from "../pi-embedded-runner/result-fallback-classifier.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "../pi-embedded-runner/tool-schema-runtime.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";
import type { AgentRuntimePlan, BuildAgentRuntimePlanParams } from "./types.js";

function formatResolvedRef(params: {
  provider: string;
  modelId: string;
  harnessId?: string;
}): string {
  return params.harnessId
    ? `${params.harnessId}:${params.provider}/${params.modelId}`
    : `${params.provider}/${params.modelId}`;
}

function hasMedia(payload: { mediaUrl?: string; mediaUrls?: string[] }): boolean {
  return resolveSendableOutboundReplyParts(payload).hasMedia;
}

export function buildAgentRuntimePlan(params: BuildAgentRuntimePlanParams): AgentRuntimePlan {
  const modelApi = params.modelApi ?? params.model?.api ?? undefined;
  const transport = params.resolvedTransport;
  const auth = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    sessionAuthProfileId: params.sessionAuthProfileId,
    config: params.config,
    workspaceDir: params.workspaceDir,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessRuntime,
  });
  const resolvedRef = {
    provider: params.provider,
    modelId: params.modelId,
    ...(modelApi ? { modelApi } : {}),
    ...(params.harnessId ? { harnessId: params.harnessId } : {}),
    ...(transport ? { transport } : {}),
  };
  const toolContext = {
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi,
    model: params.model,
  };

  return {
    resolvedRef,
    auth,
    prompt: {
      provider: params.provider,
      modelId: params.modelId,
    },
    tools: {
      normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
        tools: AgentTool<TSchemaType, TResult>[],
      ): AgentTool<TSchemaType, TResult>[] {
        return normalizeProviderToolSchemas({
          ...toolContext,
          tools,
        });
      },
      logDiagnostics(tools: AgentTool[]): void {
        logProviderToolSchemaDiagnostics({
          ...toolContext,
          tools,
        });
      },
    },
    transcript: {
      policy: resolveTranscriptPolicy({
        provider: params.provider,
        modelId: params.modelId,
        modelApi,
        config: params.config,
        workspaceDir: params.workspaceDir,
        model: params.model,
      }),
    },
    delivery: {
      isSilentPayload(payload): boolean {
        return isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN) && !hasMedia(payload);
      },
      resolveFollowupRoute(routeParams) {
        return resolveProviderFollowupFallbackRoute({
          provider: params.provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          context: {
            config: params.config,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
            provider: params.provider,
            modelId: params.modelId,
            payload: routeParams.payload,
            originatingChannel: routeParams.originatingChannel,
            originatingTo: routeParams.originatingTo,
            originRoutable: routeParams.originRoutable,
            dispatcherAvailable: routeParams.dispatcherAvailable,
          },
        });
      },
    },
    outcome: {
      classifyRunResult: classifyEmbeddedPiRunResultForModelFallback,
    },
    transport: {
      extraParams: resolvePreparedExtraParams({
        cfg: params.config,
        provider: params.provider,
        modelId: params.modelId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        extraParamsOverride: params.extraParamsOverride,
        thinkingLevel: params.thinkingLevel,
        agentId: params.agentId,
        model: params.model,
        resolvedTransport: transport as SupportedTransport | undefined,
      }),
    },
    observability: {
      resolvedRef: formatResolvedRef({
        provider: params.provider,
        modelId: params.modelId,
        harnessId: params.harnessId,
      }),
      provider: params.provider,
      modelId: params.modelId,
      ...(modelApi ? { modelApi } : {}),
      ...(params.harnessId ? { harnessId: params.harnessId } : {}),
      ...(auth.forwardedAuthProfileId ? { authProfileId: auth.forwardedAuthProfileId } : {}),
      ...(transport ? { transport } : {}),
    },
  };
}
