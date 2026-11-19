import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  sanitizeProviderReplayHistoryWithPluginAsync,
  validateProviderReplayTurnsWithPlugin,
} from "../../plugins/provider-runtime.js";
import { sanitizeGoogleAssistantFirstOrdering as sanitizeGoogleTurnOrdering } from "../../shared/google-turn-ordering.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { sanitizeSessionMessagesImages } from "../embedded-agent-helpers/images.js";
import {
  providerRequiresSignedThinking,
  shouldAllowProviderOwnedThinkingReplay,
  validateReplayTurnsForPolicy,
} from "../embedded-agent-helpers/turns.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { annotateInterSessionUserMessages } from "../replay-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionManager } from "../sessions/index.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import {
  sanitizeGenericReplayHistory,
  sanitizeReplayHistoryAfterProviderHooks,
} from "./replay-history-sanitization.js";
import {
  isSameModelSnapshot,
  MODEL_SNAPSHOT_CUSTOM_TYPE,
  type ModelSnapshotEntry,
} from "./replay-model-snapshot.js";
import {
  createProviderReplaySessionState,
  readModelSnapshotState,
} from "./replay-session-state.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  shouldPreserveLatestAssistantThinking,
  stripInvalidThinkingSignatures,
} from "./thinking.js";

export { normalizeAssistantReplayContent } from "./replay-history-sanitization.js";

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

/**
 * Applies the generic replay-history cleanup pipeline before provider-owned
 * replay hooks run.
 */
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
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  const policy = resolveReplayPolicy(params);
  const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
  const signedThinkingProvider = providerRequiresSignedThinking(params.provider);
  const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
    modelApi: params.modelApi,
    provider: params.provider,
    policy,
  });
  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-chatgpt-responses" ||
    params.modelApi === "azure-openai-responses";
  const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
  const snapshotState = hasSnapshot
    ? readModelSnapshotState(params.sessionManager)
    : { lastSnapshot: null, latestSwitchTimestamp: null };
  const priorSnapshot = snapshotState.lastSnapshot;
  const currentSnapshot: ModelSnapshotEntry | null = hasSnapshot
    ? {
        timestamp: Date.now(),
        provider: params.provider,
        modelApi: params.modelApi,
        modelId: params.modelId,
      }
    : null;
  const modelChanged =
    priorSnapshot && currentSnapshot ? !isSameModelSnapshot(priorSnapshot, currentSnapshot) : false;
  const latestModelSwitchTimestamp = modelChanged
    ? currentSnapshot?.timestamp
    : snapshotState.latestSwitchTimestamp;
  let messages = await sanitizeGenericReplayHistory(
    {
      messages: withInterSessionMarkers,
      allowedToolNames: params.allowedToolNames,
      policy,
      imageLimits: resolveImageSanitizationLimits(params.config),
      signedThinkingProvider,
      allowProviderOwnedThinkingReplay,
      isOpenAIResponsesApi,
      latestModelSwitchTimestamp,
      preserveLatestAssistantThinking: params.preserveLatestAssistantThinking,
    },
    {
      sanitizeSessionMessagesImages,
      shouldPreserveLatestAssistantThinking,
      stripInvalidThinkingSignatures,
      dropReasoningFromHistory,
      dropThinkingBlocks,
    },
  );
  const provider = params.provider?.trim();
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const replaySession = createProviderReplaySessionState(params.sessionManager);
    try {
      const context = {
        ...pluginParams.context,
        sessionId: params.sessionId ?? "",
        messages,
        allowedToolNames: params.allowedToolNames,
        sessionState: replaySession.state,
      };
      const providerResult = await sanitizeProviderReplayHistoryWithPluginAsync({
        ...pluginParams,
        context,
      });
      messages = providerResult ?? context.messages;
    } finally {
      replaySession.close();
    }
  }
  messages = sanitizeReplayHistoryAfterProviderHooks(messages, { isOpenAIResponsesApi, policy });

  if (currentSnapshot && (!priorSnapshot || modelChanged)) {
    try {
      await params.sessionManager.appendCustomEntryAsync(
        MODEL_SNAPSHOT_CUSTOM_TYPE,
        currentSnapshot,
      );
    } catch (error) {
      rethrowIncognitoSessionError(error);
      // ignore persistence failures
    }
  }

  if (!policy.applyGoogleTurnOrdering) {
    return messages;
  }

  // Strict OpenAI-compatible providers (vLLM, Gemma, etc.) also reject
  // conversations that start with an assistant turn (e.g. delivery-mirror
  // messages after /new). Provider hooks may already have applied a
  // provider-owned ordering rewrite above; keep this generic fallback for the
  // strict OpenAI-compatible path and for any provider that leaves assistant-
  // first repair to core. See #38962.
  return sanitizeGoogleTurnOrdering(messages);
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
  let messages = params.messages;
  const provider = params.provider?.trim();
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const context = { ...pluginParams.context, messages };
    const providerValidated = await validateProviderReplayTurnsWithPlugin({
      ...pluginParams,
      context,
    });
    if (providerValidated) {
      return providerValidated;
    }
    messages = context.messages;
  }

  return validateReplayTurnsForPolicy(messages, policy, params.modelApi, params.preserveUserTurns);
}
