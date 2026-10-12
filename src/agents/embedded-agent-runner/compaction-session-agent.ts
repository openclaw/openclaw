import type { LlmRuntime } from "@openclaw/ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveProviderTextTransforms } from "../../plugins/provider-runtime.js";
import { wrapStreamFnTextTransforms } from "../plugin-text-transforms.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import type { StreamFn } from "../runtime/index.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import {
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStream,
} from "./stream-resolution.js";
import { mapThinkingLevelForProvider } from "./utils.js";

export async function prepareCompactionSessionAgent(params: {
  session: { agent: { streamFn?: StreamFn } };
  llmRuntime: LlmRuntime;
  providerStreamFn: StreamFn | undefined;
  sessionId: string;
  signal: AbortSignal;
  effectiveModel: ProviderRuntimeModel;
  resolvedApiKey?: string;
  authStorage: Parameters<typeof resolveEmbeddedAgentStream>[0]["authStorage"];
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  thinkLevel: ThinkLevel;
  sessionAgentId: string;
  effectiveWorkspace: string;
  agentDir: string;
  runtimePlan?: AgentRuntimePlan;
}) {
  const transportApiKey = params.authStorage
    ? await resolveEmbeddedAgentApiKey({
        ...params,
        provider: params.effectiveModel.provider,
      })
    : params.resolvedApiKey;
  params.session.agent.streamFn = resolveEmbeddedAgentStream({
    ...params,
    currentStreamFn: resolveEmbeddedAgentBaseStreamFn({ session: params.session }),
    model: params.effectiveModel,
    transportAuthAvailable: Boolean(transportApiKey?.trim()),
    authProfileId: params.runtimePlan?.auth.forwardedAuthProfileId,
  }).streamFn;
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.effectiveWorkspace,
    runtimeHandle: getModelProviderRuntimePluginHandle(params.effectiveModel),
  });
  if (providerTextTransforms) {
    params.session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: params.session.agent.streamFn,
      input: providerTextTransforms.input,
      output: providerTextTransforms.output,
      transformSystemPrompt: false,
    });
  }
  const providerThinkingLevel = mapThinkingLevelForProvider(
    params.thinkLevel,
    params.effectiveModel,
  );
  const preparedRuntimeExtraParams = params.runtimePlan?.transport.resolveExtraParams({
    thinkingLevel: providerThinkingLevel,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    model: params.effectiveModel,
  });
  const extraParams = applyExtraParamsToAgent(
    params.session.agent,
    params.config,
    params.provider,
    params.modelId,
    undefined,
    providerThinkingLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.effectiveModel,
    params.agentDir,
    undefined,
    {
      ...(preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : {}),
      auth: params.runtimePlan?.auth.selectedAuthMode
        ? {
            mode: params.runtimePlan.auth.selectedAuthMode,
            authFlow: params.runtimePlan.auth.selectedAuthFlow,
          }
        : undefined,
      nativeWebSearchPolicyContext: {
        // Summaries have no tool loop; provider-hosted tools must not inherit
        // the originating conversation's broader web-search authority.
        webSearchEnabled: false,
        runtimeToolAllowlist: [],
      },
    },
  );
  return { ...extraParams, transportApiKey };
}
