/**
 * Builds runtime context for context-engine backed embedded compaction.
 */
import type { ThinkLevel, ThinkingCatalogEntry } from "../../auto-reply/thinking.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  listActiveProcessSessionReferences,
  type ActiveProcessSessionReference,
} from "../bash-process-references.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import type { ModelRef } from "../model-ref-shared.js";
import { resolveCompactionModelSelection } from "../model-selection-compaction.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../openai-routing.js";
import { agentRuntimeAuthPlanMatchesTarget } from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { resolveCandidateThinkingLevel } from "../thinking-runtime.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";
import { normalizeContextTokenBudget } from "./utils.js";

type EmbeddedCompactionRuntimeContextParams = Omit<
  Partial<CompactEmbeddedAgentSessionParams>,
  | "workspaceDir"
  | "sessionKey"
  | "messageChannel"
  | "messageProvider"
  | "chatType"
  | "agentAccountId"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "authProfileId"
  | "cwd"
  | "senderId"
  | "provider"
  | "model"
> & {
  workspaceDir: string;
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  chatType?: ChatType | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  cwd?: string | null;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  resolvedTarget?: ModelRef;
  harnessRuntime?: string | null;
  activeProcessSessions?: ActiveProcessSessionReference[];
};

/** Resolve the configured compaction override against the actual model/runtime candidate. */
export function resolveEmbeddedCompactionThinkingLevel(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  inheritedLevel?: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
  agentId?: string;
  sessionKey?: string;
  agentRuntime?: string | null;
}): ThinkLevel {
  const configuredLevel = params.config?.agents?.defaults?.compaction?.thinkingLevel;
  const requestedLevel =
    configuredLevel === "inherit" ? params.inheritedLevel : (configuredLevel ?? "low");
  if (!requestedLevel) {
    return "off";
  }
  // A compaction model override or fallback can change the supported level set.
  // Revalidate the immutable request for every concrete candidate instead of
  // carrying a level clamped for an earlier model into a later attempt.
  return (
    resolveCandidateThinkingLevel({
      cfg: params.config,
      provider: params.provider,
      modelId: params.modelId,
      level: requestedLevel,
      catalog: params.catalog,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentRuntime: params.agentRuntime,
    }) ?? "off"
  );
}

export function resolveCompactionTargetRuntime(params: {
  provider: string | undefined;
  authProfileId?: string;
  harnessRuntime?: string | null;
  config?: OpenClawConfig;
}): {
  runtimeProvider?: string;
  contextProvider?: string;
  nativeHarnessCompaction?: true;
} {
  if (!params.provider) {
    return {};
  }
  const selectedHarnessRuntime = normalizeOptionalAgentRuntimeId(params.harnessRuntime);
  // Compaction follows the concrete session or prepared-plan owner. Provider
  // defaults choose new runs; they cannot move an existing transcript.
  const useNativeHarnessRuntime =
    selectedHarnessRuntime !== undefined &&
    selectedHarnessRuntime !== "openclaw" &&
    !isDefaultAgentRuntimeId(selectedHarnessRuntime);
  const runtimeProvider = resolveSelectedOpenAIRuntimeProvider({
    provider: params.provider,
    harnessRuntime: useNativeHarnessRuntime ? selectedHarnessRuntime : "openclaw",
    authProfileId: params.authProfileId,
    config: params.config,
  });
  const routedRuntimeProvider = runtimeProvider === params.provider ? undefined : runtimeProvider;
  return {
    runtimeProvider: routedRuntimeProvider,
    contextProvider: useNativeHarnessRuntime ? routedRuntimeProvider : undefined,
    ...(useNativeHarnessRuntime ? { nativeHarnessCompaction: true } : {}),
  };
}

/** Binds credentials and the retained harness after compaction model selection. */
export function resolveEmbeddedCompactionTarget(
  params: Parameters<typeof resolveCompactionModelSelection>[0] & {
    authProfileId?: string | null;
    harnessRuntime?: string | null;
  },
) {
  const target = resolveCompactionModelSelection(params);
  const provider = params.provider?.trim() || params.defaultProvider;
  // A provider switch cannot inherit credentials selected for the session's
  // original provider; all target paths share that boundary.
  const authProfileId =
    target.provider !== provider ? undefined : (params.authProfileId ?? undefined);
  return {
    ...target,
    ...resolveCompactionTargetRuntime({ ...params, provider: target.provider, authProfileId }),
    authProfileId,
  };
}

/** Resolves the concrete harness already bound to this exact compaction target. */
export function resolveCompactionHarnessRuntime(params: {
  boundHarnessRuntime?: string | null;
  preparedRuntimePlan?: AgentRuntimePlan;
  configuredHarnessRuntime?: string | null;
  provider: string;
  modelId: string;
}): string | undefined {
  const boundHarnessRuntime = normalizeOptionalAgentRuntimeId(params.boundHarnessRuntime);
  if (boundHarnessRuntime) {
    return boundHarnessRuntime;
  }
  const preparedRuntimePlan = params.preparedRuntimePlan;
  if (
    preparedRuntimePlan &&
    agentRuntimeAuthPlanMatchesTarget(preparedRuntimePlan.auth, {
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    const preparedHarnessRuntime = normalizeOptionalAgentRuntimeId(
      preparedRuntimePlan.resolvedRef.harnessId,
    );
    if (preparedHarnessRuntime) {
      return preparedHarnessRuntime;
    }
  }
  return normalizeOptionalAgentRuntimeId(params.configuredHarnessRuntime);
}

/** Resolves the shared policy, target, and harness ownership for either compaction entry point. */
export function resolveCompactionContextTokenBudget(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  agentId?: string;
  requestedTokenBudget?: number;
  fallbackTokenBudget?: number;
}) {
  // Caller budgets stay bounded by the selected model ceiling.
  const resolvedBudget =
    normalizeContextTokenBudget(
      resolveContextWindowInfo({
        cfg: params.config,
        provider: params.provider,
        modelId: params.modelId,
        modelContextTokens: readAgentModelContextTokens(params.model),
        modelContextWindow: params.model?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      }).tokens,
    ) ?? DEFAULT_CONTEXT_TOKENS;
  return Math.min(
    normalizeContextTokenBudget(params.requestedTokenBudget) ??
      normalizeContextTokenBudget(params.fallbackTokenBudget) ??
      resolvedBudget,
    resolvedBudget,
  );
}

export function buildEmbeddedCompactionRuntimeContext(
  params: EmbeddedCompactionRuntimeContextParams,
) {
  // Prepared compaction already owns its model identity. Re-reading its alias
  // would replay normalization; only the final auth and harness still need binding.
  const resolved = params.resolvedTarget
    ? {
        ...params.resolvedTarget,
        authProfileId: params.authProfileId ?? undefined,
        ...resolveCompactionTargetRuntime({
          ...params,
          provider: params.resolvedTarget.provider,
          authProfileId: params.authProfileId ?? undefined,
        }),
      }
    : resolveEmbeddedCompactionTarget({
        config: params.config,
        provider: params.provider,
        modelId: params.modelId,
        authProfileId: params.authProfileId,
        harnessRuntime: params.harnessRuntime,
        modelSelectionLocked: params.modelSelectionLocked,
      });
  const agentHarnessId = params.harnessRuntime?.trim() || undefined;
  const runtimeAuthPlan =
    params.runtimeAuthPlan &&
    resolved.provider &&
    resolved.model &&
    agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, {
      provider: resolved.provider,
      modelId: resolved.model,
    })
      ? params.runtimeAuthPlan
      : undefined;
  const processScopeKey = params.sessionKey?.trim();
  const activeProcessSessions =
    params.activeProcessSessions ??
    listActiveProcessSessionReferences({
      scopeKey: processScopeKey,
    });
  return {
    sessionKey: params.sessionKey ?? undefined,
    sandboxSessionKey: params.sandboxSessionKey,
    sandboxAgentId: params.sandboxAgentId,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    clientCaps: params.clientCaps,
    chatType: params.chatType ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    conversationRoutePeerId: params.conversationRoutePeerId,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    authProfileIdSource: params.authProfileIdSource,
    runtimeAuthPlan,
    agentHarnessId,
    modelSelectionLocked: params.modelSelectionLocked,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd ?? undefined,
    permissionMode: params.permissionMode,
    sessionRoot: params.sessionRoot,
    agentDir: params.agentDir,
    config: params.config,
    toolOverrides: params.toolOverrides,
    toolsAllow: params.toolsAllow,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    runtimeProvider: resolved.runtimeProvider,
    model: resolved.model,
    modelFallbacksOverride: params.modelFallbacksOverride,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    execOverrides: params.execOverrides,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ownerNumbers: params.ownerNumbers,
    ...(activeProcessSessions.length > 0 ? { activeProcessSessions } : {}),
  };
}
