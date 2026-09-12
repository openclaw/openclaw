import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  type ThinkLevel,
} from "../../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../sessions/agent-harness-session-key.js";
import {
  applyModelOverrideToSessionEntry,
  createConfiguredPrimarySessionEntry,
  ModelSelectionLockedError,
  isModelSelectionLocked,
  repairProviderWrappedModelOverride,
} from "../../sessions/model-overrides.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentConfig,
} from "../agent-scope.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../model-fallback.types.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { resolveConfiguredModelPrimaryValue } from "../model-selection-shared.js";
import {
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelAliasFromPair,
  resolveThinkingDefault,
} from "../model-selection.js";
import { resolveConfiguredThinkingDefault } from "../model-thinking-default.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../model-visibility-policy.js";
import { resolveSessionRuntimeOverrideForProvider } from "../session-runtime-compat.js";
import {
  hasResolvedThinkingCatalogEntry,
  normalizeThinkingCatalogProviders,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import {
  normalizeAgentCommandDefaultModelRef,
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "./model-ref.js";
import { resolveCommandSessionAuth } from "./model-selection-auth.js";
import { normalizeExplicitOverrideInput } from "./prepare.js";
import type { resolveAgentRunContext } from "./run-context.js";
import { resolveAgentCommandTranscript } from "./session-transcript.js";
import type { AgentCommandOpts } from "./types.js";

type AgentRunContext = ReturnType<typeof resolveAgentRunContext>;

export async function resolveEmbeddedModelSelection(params: {
  cfg: OpenClawConfig;
  catalogOwnerConfig?: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionId: string;
  storePath: string;
  sessionAgentId: string;
  workspaceDir: string;
  pluginsEnabled: boolean;
  manifestMetadataSnapshot?: PluginMetadataSnapshot;
  modelManifestContext: ModelManifestNormalizationContext;
  configuredThinkingCatalog: ModelCatalogEntry[];
  requestedThinkLevel?: ThinkLevel;
  thinkOverride?: ThinkLevel;
  thinkOnce?: ThinkLevel;
  isSubagentLane: boolean;
  suppressVisibleSessionEffects: boolean;
  runContext: AgentRunContext;
}) {
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    allowPluginNormalization: params.pluginsEnabled,
    ...params.modelManifestContext,
  });
  const configuredPrimary = resolveConfiguredModelPrimaryValue({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
  });
  let configuredDefaultAuthProfileId = splitTrailingAuthProfile(configuredPrimary ?? "").profile;
  let { provider: defaultProvider, model: defaultModel } = normalizeAgentCommandDefaultModelRef(
    params.cfg,
    configuredDefaultRef.provider,
    configuredDefaultRef.model,
    params.modelManifestContext,
  );
  let provider = defaultProvider;
  let model = defaultModel;
  let requestedRouteResolution: ModelFallbackRouteResolution = "resolved";
  let allowListPolicyFallback: { pinnedModel: string; primaryModel: string } | undefined;
  let sessionEntry = params.sessionEntry;
  const initialModelOverrideSource = sessionEntry?.modelOverrideSource;
  const hasStoredOverride = Boolean(
    initialModelOverrideSource !== "default" &&
    (sessionEntry?.modelOverride || sessionEntry?.providerOverride),
  );
  let storedModelOverrideSource =
    hasStoredOverride && initialModelOverrideSource !== "default"
      ? initialModelOverrideSource
      : undefined;
  let hasStoredAutoFallbackProvenance =
    hasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
  let hasLegacyAutoFallbackOverrideWithoutOrigin =
    hasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
  const explicitProviderOverride =
    typeof params.opts.provider === "string"
      ? normalizeExplicitOverrideInput(params.opts.provider, "provider")
      : undefined;
  const explicitModelOverride =
    typeof params.opts.model === "string"
      ? normalizeExplicitOverrideInput(params.opts.model, "model")
      : undefined;
  const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
  if (hasExplicitRunOverride && isModelSelectionLocked(sessionEntry)) {
    throw new ModelSelectionLockedError();
  }
  if (hasExplicitRunOverride && params.opts.allowModelOverride !== true) {
    throw new Error("Model override is not authorized for this caller.");
  }

  const { loadPreparedModelCatalogSnapshot } = await import("../prepared-model-catalog.js");
  const catalogSnapshot = await loadPreparedModelCatalogSnapshot({
    config: params.catalogOwnerConfig ?? params.cfg,
    agentId: params.sessionAgentId,
    workspaceDir: params.workspaceDir,
    readOnly: true,
  });
  const modelCatalog = catalogSnapshot.entries;
  const visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    catalog: modelCatalog,
    modelCatalog: catalogSnapshot,
    defaultProvider,
    defaultModel,
    agentId: params.sessionAgentId,
    allowManifestNormalization: true,
    allowPluginNormalization: params.pluginsEnabled,
    ...params.modelManifestContext,
  });
  const allowedModelCatalog = visibilityPolicy.allowedCatalog;
  if (visibilityPolicy.effectiveDefault.ref) {
    ({ provider: defaultProvider, model: defaultModel } = visibilityPolicy.effectiveDefault.ref);
    provider = defaultProvider;
    model = defaultModel;
  }
  if (visibilityPolicy.effectiveDefault.missingPrimary) {
    configuredDefaultAuthProfileId = undefined;
  }

  if (
    !isModelSelectionLocked(sessionEntry) &&
    sessionEntry &&
    params.sessionStore &&
    params.sessionKey &&
    hasStoredOverride &&
    !isValidAgentHarnessSessionStoreEntry(params.sessionKey, sessionEntry) &&
    !params.suppressVisibleSessionEffects
  ) {
    // Validate legacy model-only locks on a clone so repair rejects before mutation.
    // Durable harness locks own their model metadata and bypass generic repair entirely.
    const initialEntry = sessionEntry;
    const entry = { ...sessionEntry };
    let entryUpdated = false;
    if (hasLegacyAutoFallbackOverrideWithoutOrigin) {
      const { updated } = applyModelOverrideToSessionEntry({
        entry,
        selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
      });
      if (updated) {
        storedModelOverrideSource = undefined;
        entryUpdated = true;
      }
    }
    const repaired = repairProviderWrappedModelOverride({ entry, defaultProvider, defaultModel });
    entryUpdated ||= repaired.updated;
    const overrideProvider = entry.providerOverride?.trim() || defaultProvider;
    const overrideModel = entry.modelOverride?.trim();
    if (overrideModel) {
      const normalizedOverride = normalizeAgentCommandModelRef(
        params.cfg,
        overrideProvider,
        overrideModel,
        params.modelManifestContext,
      );
      if (!visibilityPolicy.allows(normalizedOverride)) {
        if (hasStoredAutoFallbackProvenance) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          });
          entryUpdated ||= updated;
        } else {
          entryUpdated = false;
        }
      }
    }
    if (entryUpdated) {
      sessionEntry = await persistAgentSession({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry,
        entry,
      });
      const adoptedModelOverrideSource = sessionEntry?.modelOverrideSource;
      const adoptedHasStoredOverride = Boolean(
        adoptedModelOverrideSource !== "default" &&
        (sessionEntry?.modelOverride || sessionEntry?.providerOverride),
      );
      storedModelOverrideSource = adoptedHasStoredOverride
        ? adoptedModelOverrideSource === "default"
          ? undefined
          : adoptedModelOverrideSource
        : undefined;
      hasStoredAutoFallbackProvenance =
        adoptedHasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
      hasLegacyAutoFallbackOverrideWithoutOrigin =
        adoptedHasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
    }
  }

  if (isModelSelectionLocked(sessionEntry)) {
    hasLegacyAutoFallbackOverrideWithoutOrigin = false;
  }

  const effectiveStoredOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
    ? null
    : resolveStoredModelOverride({
        sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        parentSessionKey: sessionEntry?.parentSessionKey,
        defaultProvider,
      });
  if (effectiveStoredOverride?.source === "parent") {
    storedModelOverrideSource = undefined;
    hasStoredAutoFallbackProvenance = false;
  }
  const canUseStoredOverrideFields = sessionEntry?.modelOverrideSource !== "default";
  const storedProviderOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
    ? undefined
    : (effectiveStoredOverride?.provider ??
      (canUseStoredOverrideFields ? sessionEntry?.providerOverride?.trim() : undefined));
  const storedModelOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
    ? undefined
    : (effectiveStoredOverride?.model ??
      (canUseStoredOverrideFields ? sessionEntry?.modelOverride?.trim() : undefined));
  const storedModelOverrideRouteResolution = effectiveStoredOverride?.routeResolution;
  const currentRunModelChannel = [
    params.runContext.messageChannel,
    params.opts.replyChannel,
    params.opts.channel,
  ].find((channel): channel is string => Boolean(channel && isDeliverableMessageChannel(channel)));
  const channelOverrideGroupId = currentRunModelChannel
    ? (params.runContext.groupId ?? sessionEntry?.groupId ?? params.runContext.currentChannelId)
    : (sessionEntry?.groupId ?? params.runContext.groupId ?? params.runContext.currentChannelId);
  const channelModelOverride =
    params.cfg.channels?.modelByChannel && !hasExplicitRunOverride
      ? resolveChannelModelOverride({
          cfg: params.cfg,
          channel: currentRunModelChannel ?? sessionDeliveryChannel(sessionEntry),
          groupId: channelOverrideGroupId,
          groupChatType: sessionEntry?.chatType ?? sessionDeliveryOrigin(sessionEntry)?.chatType,
          groupChannel: params.runContext.groupChannel ?? sessionEntry?.groupChannel,
          groupSubject: sessionEntry?.subject,
          parentSessionKey: sessionEntry?.parentSessionKey ?? params.sessionKey,
          directUserIds: [
            sessionDeliveryOrigin(sessionEntry)?.nativeDirectUserId,
            sessionDeliveryOrigin(sessionEntry)?.from,
            sessionDeliveryOrigin(sessionEntry)?.to,
          ],
        })
      : null;
  const normalizedChannelOverride = channelModelOverride
    ? parseAgentCommandModelRef(
        params.cfg,
        params.sessionAgentId,
        channelModelOverride.model,
        defaultProvider,
        params.modelManifestContext,
      )
    : null;
  const primaryProvider = normalizedChannelOverride?.provider ?? defaultProvider;
  const primaryModel = normalizedChannelOverride?.model ?? defaultModel;
  const hasEffectiveStoredOverride = Boolean(storedProviderOverride || storedModelOverride);
  if (normalizedChannelOverride && !hasEffectiveStoredOverride) {
    provider = normalizedChannelOverride.provider;
    model = normalizedChannelOverride.model;
    requestedRouteResolution = "resolved";
  }
  if (storedModelOverride) {
    const candidateProvider = storedProviderOverride || defaultProvider;
    const storedRouteKey = modelKey(candidateProvider, storedModelOverride);
    const storedRouteCataloged = modelCatalog.some(
      (entry) => modelKey(entry.provider, entry.id) === storedRouteKey,
    );
    const storedAlias =
      storedModelOverrideRouteResolution === "raw" && !storedRouteCataloged
        ? resolveModelAliasFromPair({
            cfg: params.cfg,
            agentId: params.sessionAgentId,
            provider: candidateProvider,
            model: storedModelOverride,
            defaultProvider,
            aliasIndex: visibilityPolicy.selectionAliasIndex,
            allowPluginNormalization: params.pluginsEnabled,
            ...params.modelManifestContext,
          })
        : null;
    const normalizedStored = normalizeAgentCommandModelRef(
      params.cfg,
      storedAlias?.provider ?? candidateProvider,
      storedAlias?.model ?? storedModelOverride,
      params.modelManifestContext,
    );
    const allowed = visibilityPolicy.allows(normalizedStored);
    if (
      !isModelSelectionLocked(sessionEntry) &&
      !allowed &&
      !hasExplicitRunOverride &&
      !hasStoredAutoFallbackProvenance
    ) {
      const pinnedModel = `${normalizedStored.provider}/${normalizedStored.model}`;
      if (!visibilityPolicy.effectiveDefault.ref) {
        throw new Error(
          `Pinned model ${sanitizeForLog(pinnedModel)} is not in your allow list, and no configured primary is usable. Use /model to change it. Your session pin is unchanged.`,
        );
      }
      allowListPolicyFallback = {
        pinnedModel,
        primaryModel: modelKey(defaultProvider, defaultModel),
      };
      provider = defaultProvider;
      model = defaultModel;
      requestedRouteResolution = "resolved";
    }
    if (isModelSelectionLocked(sessionEntry) || allowed) {
      provider = normalizedStored.provider;
      model = normalizedStored.model;
      requestedRouteResolution =
        storedAlias || storedRouteCataloged
          ? "resolved"
          : (storedModelOverrideRouteResolution ?? "raw");
    }
  }
  const autoFallbackPrimaryProbe =
    !allowListPolicyFallback && !hasExplicitRunOverride && !isModelSelectionLocked(sessionEntry)
      ? resolveAutoFallbackPrimaryProbe({
          entry: sessionEntry,
          sessionKey: params.sessionKey,
          primaryProvider,
          primaryModel,
        })
      : undefined;
  let autoFallbackPrimaryProbeSessionEntry: SessionEntry | undefined;
  if (autoFallbackPrimaryProbe && sessionEntry) {
    provider = autoFallbackPrimaryProbe.provider;
    model = autoFallbackPrimaryProbe.model;
    requestedRouteResolution = "resolved";
    autoFallbackPrimaryProbeSessionEntry = { ...sessionEntry };
    clearAutoFallbackPrimaryProbeSelection(autoFallbackPrimaryProbeSessionEntry);
  }

  if (hasExplicitRunOverride) {
    const explicitRef = explicitModelOverride
      ? explicitProviderOverride
        ? normalizeAgentCommandModelRef(
            params.cfg,
            explicitProviderOverride,
            explicitModelOverride,
            params.modelManifestContext,
          )
        : parseAgentCommandModelRef(
            params.cfg,
            params.sessionAgentId,
            explicitModelOverride,
            provider,
            params.modelManifestContext,
          )
      : explicitProviderOverride
        ? normalizeAgentCommandModelRef(
            params.cfg,
            explicitProviderOverride,
            model,
            params.modelManifestContext,
          )
        : null;
    if (!explicitRef) {
      throw new Error("Invalid model override.");
    }
    if (!visibilityPolicy.allows(explicitRef)) {
      const rejectedKey = `${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}`;
      const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
      const repairPath = visibilityPolicy.allowRepairConfigPath;
      throw new Error(
        `Model override "${rejectedKey}" is not allowed for agent "${params.sessionAgentId}" by ${policyPath}. Add "${rejectedKey}" or "${sanitizeForLog(explicitRef.provider)}/*" to ${repairPath}, or remove/empty the list to allow any model.`,
      );
    }
    provider = explicitRef.provider;
    model = explicitRef.model;
    requestedRouteResolution = "resolved";
  }
  const unresolvedSelectionKey = modelKey(provider, model);
  const missingConfiguredPrimary =
    !hasExplicitRunOverride &&
    !isModelSelectionLocked(sessionEntry) &&
    (!hasEffectiveStoredOverride || allowListPolicyFallback) &&
    !normalizedChannelOverride
      ? visibilityPolicy.effectiveDefault.missingPrimary
      : undefined;
  const allowedInitialSelection =
    isModelSelectionLocked(sessionEntry) || hasExplicitRunOverride
      ? { provider, model }
      : missingConfiguredPrimary
        ? visibilityPolicy.effectiveDefault.ref
        : visibilityPolicy.resolveSelection({ provider, model });
  if (!allowedInitialSelection) {
    if (missingConfiguredPrimary) {
      throw new Error(
        `Configured primary "${missingConfiguredPrimary}" is not in the model catalog, and no allowed default is available. Update your primary model in settings.`,
      );
    }
    const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
    throw new Error(
      `Configured default model "${modelKey(provider, model)}" is not allowed by ${policyPath}, and no allowed model is available.`,
    );
  }
  provider = allowedInitialSelection.provider;
  model = allowedInitialSelection.model;
  if (modelKey(provider, model) !== unresolvedSelectionKey) {
    requestedRouteResolution = "resolved";
  }
  const providerForAuthProfileValidation = provider;
  let sessionEntryForAttempt = autoFallbackPrimaryProbeSessionEntry ?? sessionEntry;
  if (allowListPolicyFallback && sessionEntry) {
    sessionEntryForAttempt = createConfiguredPrimarySessionEntry(sessionEntry, {
      provider: defaultProvider,
      model: defaultModel,
    });
  }
  const initialAgentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider,
    entry: sessionEntryForAttempt,
    cfg: params.cfg,
  });
  await ensureSelectedAgentHarnessPlugin({
    config: params.cfg,
    provider,
    modelId: model,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    agentHarnessRuntimeOverride: initialAgentHarnessRuntimeOverride,
    workspaceDir: params.workspaceDir,
    pluginRegistry: requireActivePluginRegistry(),
  });

  sessionEntryForAttempt = await resolveCommandSessionAuth(
    {
      ...params,
      provider: providerForAuthProfileValidation,
      model,
      defaultProvider,
      preserveStoredSelection:
        hasExplicitRunOverride ||
        Boolean(autoFallbackPrimaryProbe) ||
        Boolean(allowListPolicyFallback),
    },
    sessionEntryForAttempt,
  );

  const configuredThinkLevel = normalizeThinkLevel(
    resolveAgentConfig(params.cfg, params.sessionAgentId)?.thinkingDefault,
  );
  const immutableThinkLevel = params.requestedThinkLevel ?? configuredThinkLevel;
  const primaryConfiguredThinkLevel =
    immutableThinkLevel ??
    resolveConfiguredThinkingDefault({
      cfg: params.cfg,
      provider,
      model,
    });
  let catalogForThinking =
    allowedModelCatalog.length > 0
      ? allowedModelCatalog
      : modelCatalog.length > 0
        ? modelCatalog
        : params.configuredThinkingCatalog;
  if (
    params.pluginsEnabled &&
    primaryConfiguredThinkLevel !== "off" &&
    !hasResolvedThinkingCatalogEntry({ catalog: catalogForThinking, provider, model })
  ) {
    // Thinking capability is a per-model fact; never materialize the full live catalog here.
    const { loadProviderScopedThinkingCatalog } = await import("../model-catalog.runtime.js");
    const runtimeCatalog = normalizeThinkingCatalogProviders(
      await loadProviderScopedThinkingCatalog({
        config: params.cfg,
        catalogOwnerConfig: params.catalogOwnerConfig,
        provider,
        model,
        ...(params.sessionAgentId ? { agentId: params.sessionAgentId } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      }),
    );
    const allowedRuntimeCatalog = createModelVisibilityPolicy({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      catalog: runtimeCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.sessionAgentId,
      allowManifestNormalization: true,
      allowPluginNormalization: params.pluginsEnabled,
      ...params.modelManifestContext,
    }).allowedCatalog;
    if (
      hasResolvedThinkingCatalogEntry({
        catalog: allowedRuntimeCatalog,
        provider,
        model,
      })
    ) {
      catalogForThinking = allowedRuntimeCatalog;
    }
  }
  const thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider,
    modelId: model,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    sessionEntry: sessionEntryForAttempt,
  });
  const primaryThinkLevel =
    primaryConfiguredThinkLevel ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider,
      model,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
  if (
    !isThinkingLevelSupported({
      provider,
      model,
      level: primaryThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    })
  ) {
    const explicitThink = Boolean(params.thinkOnce || params.thinkOverride);
    const isSubagentSpawnRun = params.isSubagentLane && isSubagentSessionKey(params.sessionKey);
    if (explicitThink && !isSubagentSpawnRun) {
      throw new Error(
        `Thinking level "${primaryThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
      );
    }
  }
  if (
    params.thinkOverride &&
    params.sessionStore &&
    params.sessionKey &&
    !params.suppressVisibleSessionEffects
  ) {
    const now = Date.now();
    const entry = params.sessionStore[params.sessionKey] ??
      sessionEntry ?? { sessionId: params.sessionId, updatedAt: now, sessionStartedAt: now };
    const next: SessionEntry = {
      ...entry,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: entry.sessionStartedAt ?? now,
      lastInteractionAt: now,
      thinkingLevel: params.thinkOverride,
    };
    sessionEntry =
      (await persistAgentSession({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry: entry,
        entry: next,
      })) ?? sessionEntry;
    sessionEntryForAttempt = {
      ...(sessionEntryForAttempt ?? next),
      thinkingLevel: params.thinkOverride,
    };
  }

  const transcript = await resolveAgentCommandTranscript(params, sessionEntry);
  sessionEntry = transcript.sessionEntry;
  const sessionFile = transcript.sessionFile;

  return {
    sessionEntry,
    provider,
    model,
    requestedRouteResolution,
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    providerForAuthProfileValidation,
    visibilityPolicy,
    hasExplicitRunOverride,
    storedProviderOverride,
    storedModelOverride,
    storedModelOverrideSource,
    hasStoredAutoFallbackProvenance,
    autoFallbackPrimaryProbe,
    allowListPolicyFallback,
    missingConfiguredPrimary,
    sessionEntryForAttempt,
    thinkingCatalog,
    immutableThinkLevel,
    effectiveTurnThinkLevel: primaryThinkLevel,
    sessionFile,
  };
}

export type EmbeddedModelSelection = Awaited<ReturnType<typeof resolveEmbeddedModelSelection>>;
