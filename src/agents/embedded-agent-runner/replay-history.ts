import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  sanitizeProviderReplayHistoryWithPluginAsync,
  validateProviderReplayTurnsWithPlugin,
} from "../../plugins/provider-runtime.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionManager } from "../sessions/index.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import {
  prepareGenericReplayHistory,
  validateGenericReplayTurns,
} from "./replay-history-generic.js";
import { finishGenericReplayHistory } from "./replay-history-invariants.js";
import { MODEL_SNAPSHOT_CUSTOM_TYPE } from "./replay-model-snapshot.js";
import {
  createProviderReplaySessionState,
  readModelSnapshotState,
} from "./replay-session-state.js";

type ProviderReplayHookParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  sessionId?: string;
};

function resolveReplayPolicy(params: ProviderReplayHookParams & { policy?: TranscriptPolicy }) {
  return (
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      model: params.model,
    })
  );
}

function createProviderReplayPluginParams(params: ProviderReplayHookParams & { provider: string }) {
  const context = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    sessionId: params.sessionId,
  };
  const { provider, config, workspaceDir, env } = context;
  return { provider, config, workspaceDir, env, context };
}

export async function sanitizeSessionHistory(
  params: ProviderReplayHookParams & {
    messages: AgentMessage[];
    allowedToolNames?: Iterable<string>;
    sessionManager: SessionManager;
    sessionId: string;
    policy?: TranscriptPolicy;
    preserveLatestAssistantThinking?: boolean;
  },
): Promise<AgentMessage[]> {
  const prepared = await prepareGenericReplayHistory({
    ...params,
    policy: resolveReplayPolicy(params),
    imageLimits: resolveImageSanitizationLimits(params.config),
    snapshotState:
      params.provider || params.modelApi || params.modelId
        ? readModelSnapshotState(params.sessionManager)
        : { lastSnapshot: null, latestSwitchTimestamp: null },
  });
  let messages = prepared.messages;
  const provider = params.provider?.trim();
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const replaySession = createProviderReplaySessionState(params.sessionManager);
    try {
      const providerResult = await sanitizeProviderReplayHistoryWithPluginAsync({
        ...pluginParams,
        context: {
          ...pluginParams.context,
          sessionId: params.sessionId ?? "",
          messages,
          allowedToolNames: params.allowedToolNames,
          sessionState: replaySession.state,
        },
      });
      messages = providerResult ?? messages;
    } finally {
      replaySession.close();
    }
  }
  messages = finishGenericReplayHistory(messages, prepared.policy, params.modelApi);
  if (prepared.modelSnapshot) {
    try {
      await params.sessionManager.appendCustomEntryAsync(
        MODEL_SNAPSHOT_CUSTOM_TYPE,
        prepared.modelSnapshot,
      );
    } catch (error) {
      rethrowIncognitoSessionError(error);
      // Replay snapshot publication has always been best effort.
    }
  }
  return messages;
}

/**
 * Runs provider-owned replay validation before falling back to the remaining
 * generic validator pipeline.
 */
export async function validateReplayTurns(
  params: ProviderReplayHookParams & {
    messages: AgentMessage[];
    policy?: TranscriptPolicy;
    preserveUserTurns?: boolean;
  },
): Promise<AgentMessage[]> {
  const policy = resolveReplayPolicy(params);
  const provider = params.provider?.trim();
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const providerValidated = await validateProviderReplayTurnsWithPlugin({
      ...pluginParams,
      context: {
        ...pluginParams.context,
        messages: params.messages,
      },
    });
    if (providerValidated) {
      return providerValidated;
    }
  }

  return validateGenericReplayTurns(
    params.messages,
    policy,
    params.modelApi,
    params.preserveUserTurns,
  );
}
