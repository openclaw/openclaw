/**
 * Builds runtime context for context-engine backed embedded compaction.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  listActiveProcessSessionReferences,
  type ActiveProcessSessionReference,
} from "../bash-process-references.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../model-selection-shared.js";
import {
  openAIProviderUsesCodexRuntimeByDefault,
  resolveSelectedOpenAIRuntimeProvider,
} from "../openai-routing.js";

export type EmbeddedCompactionRuntimeContext = {
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  authProfileId?: string;
  agentHarnessId?: string;
  workspaceDir: string;
  cwd?: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string;
  provider?: string;
  runtimeProvider?: string;
  model?: string;
  modelFallbacksOverride?: string[];
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  ownerNumbers?: string[];
  activeProcessSessions?: ActiveProcessSessionReference[];
};

/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export function resolveEmbeddedCompactionTarget(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  harnessRuntime?: string | null;
  defaultProvider?: string;
  defaultModel?: string;
}): {
  provider: string | undefined;
  runtimeProvider?: string;
  contextProvider?: string;
  model: string | undefined;
  authProfileId: string | undefined;
} {
  const provider = params.provider?.trim() || params.defaultProvider;
  const model = params.modelId?.trim() || params.defaultModel;
  const override = params.config?.agents?.defaults?.compaction?.model?.trim();
  const resolveTargetProviders = (
    targetProvider: string | undefined,
    authProfileId: string | undefined,
  ) => {
    if (!targetProvider) {
      return {};
    }
    const useCodexHarnessRuntime = shouldUseCodexRuntimeProviderForCompaction({
      config: params.config,
      provider: targetProvider,
      harnessRuntime: params.harnessRuntime,
    });
    const harnessRuntime = useCodexHarnessRuntime ? params.harnessRuntime : "openclaw";
    const runtimeProvider = resolveSelectedOpenAIRuntimeProvider({
      provider: targetProvider,
      harnessRuntime: harnessRuntime ?? undefined,
      authProfileId,
      config: params.config,
    });
    const routedRuntimeProvider = runtimeProvider === targetProvider ? undefined : runtimeProvider;
    return {
      runtimeProvider: routedRuntimeProvider,
      contextProvider: useCodexHarnessRuntime ? routedRuntimeProvider : undefined,
    };
  };
  if (!override) {
    const authProfileId = params.authProfileId ?? undefined;
    return {
      provider,
      ...resolveTargetProviders(provider, authProfileId),
      model,
      authProfileId,
    };
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
    // When switching provider via override, drop the primary auth profile to
    // avoid sending the wrong credentials.
    const authProfileId =
      overrideProvider !== (params.provider ?? "")?.trim()
        ? undefined
        : (params.authProfileId ?? undefined);
    return {
      provider: overrideProvider,
      ...resolveTargetProviders(overrideProvider, authProfileId),
      model: overrideModel,
      authProfileId,
    };
  }
  // Resolve alias-only compaction model overrides through the model alias index.
  // Without this, an alias like "gpt54mini" is passed to resolveModelAsync as-is,
  // resulting in "Unknown model: openai/gpt54mini" (#90340).
  //
  // Safety: preserve bare model-id precedence. A bare override that is already a
  // configured model id for the current provider must keep shipped literal behavior
  // even when it collides with a configured alias key. Only non-colliding bare
  // values (true aliases) are resolved through the alias index.
  const defaultProvider = params.defaultProvider ?? provider;
  const aliasIndex = defaultProvider
    ? buildModelAliasIndex({
        cfg: params.config as OpenClawConfig,
        defaultProvider,
      })
    : null;
  const resolvedAlias = defaultProvider
    ? resolveModelRefFromString({
        cfg: params.config,
        raw: override,
        defaultProvider,
        aliasIndex: aliasIndex ?? undefined,
      })
    : null;
  const authProfileId = params.authProfileId ?? undefined;
  const hasAliasMatch = Boolean(resolvedAlias?.alias);
  if (hasAliasMatch && resolvedAlias && aliasIndex) {
    // The override matched a configured alias. Check whether the bare value also
    // collides with a known model id for the current provider — if it does, the
    // shipped bare-model-id behavior takes precedence to avoid a silent switch.
    const isKnownModelId = isBareModelConfiguredForProvider({
      config: params.config,
      provider: provider ?? "",
      modelId: override,
    });
    if (isKnownModelId) {
      // Bare model-id takes precedence over the alias to preserve existing behavior.
      return {
        provider,
        ...resolveTargetProviders(provider, authProfileId),
        model: override,
        authProfileId,
      };
    }
    const aliasProvider = resolvedAlias.ref.provider;
    const aliasModel = resolvedAlias.ref.model;
    const aliasAuthProfileId =
      aliasProvider !== (params.provider ?? "")?.trim()
        ? undefined
        : (params.authProfileId ?? undefined);
    return {
      provider: aliasProvider,
      ...resolveTargetProviders(aliasProvider, aliasAuthProfileId),
      model: aliasModel,
      authProfileId: aliasAuthProfileId,
    };
  }
  return {
    provider,
    ...resolveTargetProviders(provider, authProfileId),
    model: override,
    authProfileId,
  };
}

function shouldUseCodexRuntimeProviderForCompaction(params: {
  config?: OpenClawConfig;
  provider: string;
  harnessRuntime?: string | null;
}): boolean {
  if (normalizeOptionalAgentRuntimeId(params.harnessRuntime) !== "codex") {
    return false;
  }
  if (!openAIProviderUsesCodexRuntimeByDefault(params)) {
    return false;
  }
  return true;
}

/**
 * Check whether a bare model id is already configured for the given provider.
 * When true, the bare model-id takes precedence over any alias that shares the
 * same key, preserving upgrade-safe shipped-config behavior (#90340).
 */
function isBareModelConfiguredForProvider(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
}): boolean {
  const providerEntry = params.config?.models?.providers?.[params.provider];
  if (!providerEntry?.models?.length) {
    return false;
  }
  const normalized = params.modelId.toLowerCase();
  return providerEntry.models.some(
    (m) => typeof m.id === "string" && m.id.toLowerCase() === normalized,
  );
}

export function buildEmbeddedCompactionRuntimeContext(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  workspaceDir: string;
  cwd?: string | null;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  harnessRuntime?: string | null;
  modelFallbacksOverride?: string[];
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  ownerNumbers?: string[];
  activeProcessSessions?: ActiveProcessSessionReference[];
}): EmbeddedCompactionRuntimeContext {
  const resolved = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    harnessRuntime: params.harnessRuntime,
  });
  const agentHarnessId = params.harnessRuntime?.trim() || undefined;
  const processScopeKey = params.sessionKey?.trim();
  const activeProcessSessions =
    params.activeProcessSessions ??
    listActiveProcessSessionReferences({
      scopeKey: processScopeKey,
    });
  return {
    sessionKey: params.sessionKey ?? undefined,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    agentHarnessId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd ?? undefined,
    agentDir: params.agentDir,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    runtimeProvider: resolved.runtimeProvider,
    model: resolved.model,
    modelFallbacksOverride: params.modelFallbacksOverride,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ownerNumbers: params.ownerNumbers,
    ...(activeProcessSessions.length > 0 ? { activeProcessSessions } : {}),
  };
}
