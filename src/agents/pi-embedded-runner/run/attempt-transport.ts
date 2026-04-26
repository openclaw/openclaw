import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveProviderTextTransforms } from "../../../plugins/provider-runtime.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
} from "../extra-params.js";
import { resolveCacheRetention } from "../prompt-cache-retention.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import { shouldUseOpenAIWebSocketTransport } from "./attempt.thread-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptTransportSession = {
  sessionId: string;
  agent: {
    streamFn: StreamFn;
    transport?: unknown;
  };
};

type AttemptTransportSettingsManager = Parameters<
  typeof resolveExplicitSettingsTransport
>[0]["settingsManager"];

export async function configureAttemptTransportRuntime(params: {
  activeSession: AttemptTransportSession;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  model: EmbeddedRunAttemptParams["model"];
  agentDir: string;
  effectiveWorkspace: string;
  resolvedApiKey?: string;
  authStorage: EmbeddedRunAttemptParams["authStorage"];
  runAbortSignal: AbortSignal;
  settingsManager: AttemptTransportSettingsManager;
  streamParams?: EmbeddedRunAttemptParams["streamParams"];
  fastMode?: boolean;
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
  sessionAgentId?: string;
  runtimePlan?: AgentRuntimePlan;
  logDebug: (message: string) => void;
  logWarn: (message: string) => void;
}) {
  // Rebuild each turn from the session's original stream base so prior-turn
  // wrappers do not pin us to stale provider/API transport behavior.
  const defaultSessionStreamFn = resolveEmbeddedAgentBaseStreamFn({
    session: params.activeSession,
  });
  const providerStreamFn = registerProviderStreamForModel({
    model: params.model,
    cfg: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.effectiveWorkspace,
  });
  const shouldUseWebSocketTransport = shouldUseOpenAIWebSocketTransport({
    provider: params.provider,
    modelApi: params.model.api,
    modelBaseUrl: params.model.baseUrl,
  });
  const wsApiKey = shouldUseWebSocketTransport
    ? await resolveEmbeddedAgentApiKey({
        provider: params.provider,
        resolvedApiKey: params.resolvedApiKey,
        authStorage: params.authStorage,
      })
    : undefined;
  if (shouldUseWebSocketTransport && !wsApiKey) {
    params.logWarn(
      `[ws-stream] no API key for provider=${params.provider}; keeping session-managed HTTP transport`,
    );
  }
  const streamStrategy = describeEmbeddedAgentStreamStrategy({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    shouldUseWebSocketTransport,
    wsApiKey,
    model: params.model,
  });
  params.activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    shouldUseWebSocketTransport,
    wsApiKey,
    sessionId: params.activeSession.sessionId,
    signal: params.runAbortSignal,
    model: params.model,
    resolvedApiKey: params.resolvedApiKey,
    authStorage: params.authStorage,
  });

  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.effectiveWorkspace,
  });
  if (providerTextTransforms) {
    params.activeSession.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: params.activeSession.agent.streamFn,
      input: providerTextTransforms.input,
      output: providerTextTransforms.output,
      transformSystemPrompt: false,
    });
  }

  const resolvedTransport = resolveExplicitSettingsTransport({
    settingsManager: params.settingsManager,
    sessionTransport: params.activeSession.agent.transport,
  });
  const streamExtraParamsOverride = {
    ...params.streamParams,
    fastMode: params.fastMode,
  };
  const preparedRuntimeExtraParams = params.runtimePlan?.transport.resolveExtraParams({
    extraParamsOverride: streamExtraParamsOverride,
    thinkingLevel: params.thinkLevel,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    model: params.model,
    resolvedTransport,
  });
  const { effectiveExtraParams } = applyExtraParamsToAgent(
    params.activeSession.agent,
    params.config,
    params.provider,
    params.modelId,
    streamExtraParamsOverride,
    params.thinkLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.model,
    params.agentDir,
    resolvedTransport,
    preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : undefined,
  );
  const effectivePromptCacheRetention = resolveCacheRetention(
    effectiveExtraParams,
    params.provider,
    params.model.api,
    params.modelId,
  );
  const agentTransportOverride = resolveAgentTransportOverride({
    settingsManager: params.settingsManager,
    effectiveExtraParams,
  });
  const sessionTransport =
    typeof params.activeSession.agent.transport === "string"
      ? params.activeSession.agent.transport
      : undefined;
  const effectiveAgentTransport = agentTransportOverride ?? sessionTransport;
  if (agentTransportOverride && params.activeSession.agent.transport !== agentTransportOverride) {
    const previousTransport = params.activeSession.agent.transport;
    params.logDebug(
      `embedded agent transport override: ${previousTransport} -> ${agentTransportOverride} ` +
        `(${params.provider}/${params.modelId})`,
    );
  }

  return {
    effectiveExtraParams,
    effectivePromptCacheRetention,
    effectiveAgentTransport,
    streamStrategy,
  };
}
