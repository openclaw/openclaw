import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { isStaleAutoFallbackOverride } from "../../auto-reply/reply/stored-model-override.js";
import {
  formatThinkingLevels,
  normalizeThinkLevel,
  type ThinkLevel,
} from "../../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { hasSessionAutoModelSelection } from "../../config/sessions/model-override-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../sessions/agent-harness-session-key.js";
import { shouldPreserveUnavailableSessionAuthProfileOverride } from "../../sessions/auth-profile-preservation.js";
import {
  applyModelOverrideToSessionEntry,
  ModelSelectionLockedError,
  isModelSelectionLocked,
  repairProviderWrappedModelOverride,
} from "../../sessions/model-overrides.js";
import {
  resolveDirectStoredModelOverride,
  resolveStoredModelOverrideCore,
} from "../../sessions/stored-model-overrides.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  assertAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
} from "../admitted-run-context.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentConfig,
  resolveAgentDir,
  resolveNativeModelPrimary,
} from "../agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { resolveModelProviderAuthConfig } from "../model-auth-provider-route.js";
import { findModelInCatalog } from "../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { dedupeModelCatalogEntries } from "../model-selection-shared.js";
import { resolveDefaultModelForAgent, resolveModelAliasFromPair } from "../model-selection.js";
import {
  resolveConfiguredThinkingDefault,
  resolveThinkingSelection,
} from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { resolveOperatorModelDefault } from "../operator-model-policy.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { resolveSessionRuntimeOverrideForProvider } from "../session-runtime-compat.js";
import {
  needsThinkHydration,
  normalizeThinkingCatalogProviders,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import { normalizeAgentCommandModelRef, parseAgentCommandModelRef } from "./model-ref.js";
import { prepareCommandModelCatalog } from "./model-selection-catalog.js";
import { normalizeExplicitOverrideInput } from "./prepare.js";
import { loadTranscriptResolveRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

export async function resolveEmbeddedModelSelection(params: {
  cfg: OpenClawConfig;
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
  const operatorAuthority = params.opts.operatorAuthority;
  if (operatorAuthority) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    allowPluginNormalization: params.pluginsEnabled,
    ...params.modelManifestContext,
  });
  const configuredDefaultAuthProfileId = splitTrailingAuthProfile(
    resolveNativeModelPrimary(params.cfg, params.sessionAgentId) ?? "",
  ).profile;
  const { provider: defaultProvider, model: defaultModel } = configuredDefaultRef;
  let provider = defaultProvider;
  let model = defaultModel;
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

  const { visibilityPolicy, modelCatalog, loadDeferredThinkingCatalog } =
    prepareCommandModelCatalog({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      sessionEntry,
      hasExplicitRunOverride,
      metadataSnapshot: params.manifestMetadataSnapshot,
      pluginsEnabled: params.pluginsEnabled,
      workspaceDir: params.workspaceDir,
      defaultProvider,
      defaultModel,
      modelManifestContext: params.modelManifestContext,
    });

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

  if (
    (!hasExplicitRunOverride || !operatorAuthority?.modelPolicy) &&
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
    const directOverride = resolveDirectStoredModelOverride({
      sessionEntry: entry,
      defaultProvider,
      allowPluginNormalization: params.pluginsEnabled,
      ...params.modelManifestContext,
    });
    if (directOverride) {
      const normalizedOverride = {
        provider: directOverride.provider ?? defaultProvider,
        model: directOverride.model,
      };
      const staleAutoFallbackOverride = isStaleAutoFallbackOverride({
        sessionEntry: entry,
        storedOverride: directOverride,
        defaultProvider,
        defaultModel,
        primaryProvider,
        primaryModel,
      });
      if (
        staleAutoFallbackOverride ||
        (!hasSessionAutoModelSelection(entry) && !visibilityPolicy.allows(normalizedOverride))
      ) {
        const { updated } = applyModelOverrideToSessionEntry({
          entry,
          selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          preserveAuthProfileOverride: staleAutoFallbackOverride,
        });
        entryUpdated ||= updated;
      }
    }
    if (entryUpdated) {
      sessionEntry = await persistAgentSession({
        agentId: params.sessionAgentId,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry,
        entry,
        assertCommitAllowed: operatorAuthority?.assertCurrent,
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
    : resolveStoredModelOverrideCore({
        sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        parentSessionKey: sessionEntry?.parentSessionKey,
        defaultProvider,
        allowPluginNormalization: params.pluginsEnabled,
        ...params.modelManifestContext,
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
  const hasStoredAutomaticSelection =
    effectiveStoredOverride?.source === "session" && hasSessionAutoModelSelection(sessionEntry);
  const hasEffectiveStoredOverride = Boolean(storedProviderOverride || storedModelOverride);
  if (normalizedChannelOverride && !hasEffectiveStoredOverride) {
    provider = normalizedChannelOverride.provider;
    model = normalizedChannelOverride.model;
  }
  if (storedModelOverride) {
    const candidateProvider = storedProviderOverride || defaultProvider;
    const storedRouteCataloged = modelCatalog.some(
      (entry) => entry.provider === candidateProvider && entry.id === storedModelOverride,
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
    const normalizedStored = storedAlias ?? {
      provider: candidateProvider,
      model: storedModelOverride,
    };
    if (
      isModelSelectionLocked(sessionEntry) ||
      hasStoredAutomaticSelection ||
      visibilityPolicy.allows(normalizedStored)
    ) {
      provider = normalizedStored.provider;
      model = normalizedStored.model;
    }
  }
  const autoFallbackPrimaryProbe =
    !hasExplicitRunOverride &&
    !isModelSelectionLocked(sessionEntry) &&
    (operatorAuthority?.modelPolicy?.allows({ provider: primaryProvider, model: primaryModel }) ??
      true)
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
    assertOperatorModelAllowed(operatorAuthority, explicitRef);
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
  }
  const allowedInitialSelection =
    isModelSelectionLocked(sessionEntry) ||
    (hasStoredAutomaticSelection && !hasExplicitRunOverride && !autoFallbackPrimaryProbe)
      ? { provider, model }
      : visibilityPolicy.resolveSelection({ provider, model, routeResolution: "resolved" });
  if (!allowedInitialSelection) {
    const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
    throw new Error(
      `Configured default model "${buildModelCatalogRef(provider, model)}" is not allowed by ${policyPath}, and no allowed model is available.`,
    );
  }
  const operatorSelection =
    hasExplicitRunOverride || isModelSelectionLocked(sessionEntry)
      ? allowedInitialSelection
      : resolveOperatorModelDefault({
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          ...params.modelManifestContext,
          policy: operatorAuthority?.modelPolicy,
          model: allowedInitialSelection,
          allows: visibilityPolicy.allows,
        });
  assertOperatorModelAllowed(operatorAuthority, operatorSelection);
  if (!operatorSelection) {
    throw new Error("No model is available for this operator role and agent.");
  }
  provider = operatorSelection.provider;
  model = operatorSelection.model;
  const operatorModelOverride =
    provider !== allowedInitialSelection.provider || model !== allowedInitialSelection.model;
  const providerForAuthProfileValidation = provider;
  let sessionEntryForAttempt = autoFallbackPrimaryProbeSessionEntry ?? sessionEntry;
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
  assertOperatorModelAllowed(operatorAuthority, { provider, model });

  const authProfileId = sessionEntryForAttempt?.authProfileOverride;
  if (sessionEntryForAttempt && authProfileId) {
    const entry = sessionEntryForAttempt;
    const authConfig = resolveModelProviderAuthConfig({
      config: params.cfg,
      provider: providerForAuthProfileValidation,
      modelId: model,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.pluginsEnabled ? params.manifestMetadataSnapshot : { plugins: [] },
    });
    const agentDir = resolveAgentDir(params.cfg, params.sessionAgentId);
    const store = ensureAuthProfileStore(agentDir, {
      profileId: authProfileId,
      config: params.cfg,
      allowKeychainPrompt: false,
    });
    const profile = store.profiles[authProfileId];
    const validationHarnessPolicy = resolveAvailableAgentHarnessPolicy({
      provider: providerForAuthProfileValidation,
      modelId: model,
      config: params.cfg,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
    });
    const authAliasLookupParams = params.pluginsEnabled
      ? {
          config: authConfig,
          workspaceDir: params.workspaceDir,
          ...(params.manifestMetadataSnapshot
            ? { metadataSnapshot: params.manifestMetadataSnapshot }
            : {}),
        }
      : {
          config: authConfig,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: { plugins: [] },
        };
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: providerForAuthProfileValidation,
      harnessRuntime: validationHarnessPolicy.runtime,
      config: params.cfg,
    }).map((candidateProvider) =>
      params.pluginsEnabled
        ? resolveProviderIdForAuth(candidateProvider, authAliasLookupParams)
        : candidateProvider,
    );
    const profileMatchesRuntime =
      profile &&
      acceptedAuthProviders.some((candidateProvider) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: authConfig,
          authAliasLookupParams,
          provider: candidateProvider,
          credential: profile,
        }),
      );
    const preserveUnavailableSelection = shouldPreserveUnavailableSessionAuthProfileOverride({
      store,
      cfg: authConfig,
      agentDir,
      entry,
      currentProvider: entry.providerOverride ?? defaultProvider,
      provider: providerForAuthProfileValidation,
      metadataSnapshot: params.pluginsEnabled ? params.manifestMetadataSnapshot : { plugins: [] },
    });
    if (!profileMatchesRuntime && !preserveUnavailableSelection) {
      if (hasExplicitRunOverride || autoFallbackPrimaryProbe || operatorModelOverride) {
        sessionEntryForAttempt = {
          ...entry,
          authProfileOverride: undefined,
          authProfileOverrideSource: undefined,
          authProfileOverrideCompactionCount: undefined,
        };
      } else if (
        params.sessionStore &&
        params.sessionKey &&
        !params.suppressVisibleSessionEffects
      ) {
        await clearSessionAuthProfileOverride({
          agentId: params.sessionAgentId,
          sessionEntry: entry,
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
      }
    }
  }

  const configuredThinkLevel = normalizeThinkLevel(
    resolveAgentConfig(params.cfg, params.sessionAgentId)?.thinkingDefault,
  );
  const immutableThinkLevel = params.requestedThinkLevel ?? configuredThinkLevel;
  const primaryConfiguredThinkLevel =
    immutableThinkLevel ??
    resolveConfiguredThinkingDefault({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      provider,
      model,
    });
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider,
    modelId: model,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    sessionEntry: sessionEntryForAttempt,
  });
  let catalogForThinking =
    visibilityPolicy.catalog.length > 0
      ? visibilityPolicy.catalog
      : params.configuredThinkingCatalog;
  if (
    params.pluginsEnabled &&
    (primaryConfiguredThinkLevel !== "off" || thinkingRuntime !== "openclaw") &&
    needsThinkHydration(catalogForThinking, provider, model, thinkingRuntime)
  ) {
    // Thinking capability is a per-model fact; never materialize the full live catalog here.
    const { loadProviderScopedThinkingCatalog } = await import("../model-catalog.runtime.js");
    const runtimeCatalog = normalizeThinkingCatalogProviders(
      await loadProviderScopedThinkingCatalog({
        config: params.cfg,
        provider,
        model,
        agentRuntime: thinkingRuntime,
        ...(params.sessionAgentId ? { agentId: params.sessionAgentId } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      }),
    );
    const refreshedModel = findModelInCatalog(runtimeCatalog, provider, model);
    if (refreshedModel) {
      // Replace this route's row whole; later fallback routes retain their prepared capabilities.
      catalogForThinking = createModelVisibilityPolicy({
        cfg: params.cfg,
        catalog: dedupeModelCatalogEntries([refreshedModel, ...catalogForThinking]),
        defaultProvider,
        defaultModel: configuredDefaultRef,
        agentId: params.sessionAgentId,
        allowManifestNormalization: true,
        allowPluginNormalization: params.pluginsEnabled,
        ...params.modelManifestContext,
      }).catalog;
    }
  }
  const thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
  const primaryThinking = resolveThinkingSelection({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    provider,
    model,
    level: primaryConfiguredThinkLevel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  });
  if (!primaryThinking.supported) {
    const explicitThink = Boolean(params.thinkOnce || params.thinkOverride);
    const isSubagentSpawnRun = params.isSubagentLane && isSubagentSessionKey(params.sessionKey);
    if (explicitThink && !isSubagentSpawnRun) {
      throw new Error(
        `Thinking level "${primaryThinking.requestedLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
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
        agentId: params.sessionAgentId,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry: entry,
        entry: next,
        assertCommitAllowed: operatorAuthority?.assertCurrent,
      })) ?? sessionEntry;
    sessionEntryForAttempt = {
      ...(sessionEntryForAttempt ?? next),
      thinkingLevel: params.thinkOverride,
    };
  }

  const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
  assertOperatorModelAllowed(operatorAuthority, { provider, model });
  // Fallback tokens must not adopt entries from a store without a nonempty session key.
  const hasKeyedSessionStore = Boolean(params.sessionStore && params.sessionKey);
  const resolvedSessionFile = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? params.sessionId,
    sessionStore:
      hasKeyedSessionStore && !params.suppressVisibleSessionEffects
        ? params.sessionStore
        : undefined,
    storePath:
      hasKeyedSessionStore && params.suppressVisibleSessionEffects ? undefined : params.storePath,
    sessionEntry,
    agentId: params.sessionAgentId,
    threadId: params.opts.threadId,
  });
  const sessionFile = resolvedSessionFile.sessionFile;
  sessionEntry = resolvedSessionFile.sessionEntry;

  return {
    sessionEntry,
    provider,
    model,
    requestedRouteResolution: "resolved" as const,
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    providerForAuthProfileValidation,
    hasExplicitRunOverride,
    storedProviderOverride,
    storedModelOverride,
    storedModelOverrideSource,
    hasStoredAutoFallbackProvenance,
    autoFallbackPrimaryProbe,
    sessionEntryForAttempt,
    thinkingCatalog,
    ...(loadDeferredThinkingCatalog ? { loadDeferredThinkingCatalog } : {}),
    immutableThinkLevel,
    effectiveTurnThinkLevel: primaryThinking.requestedLevel,
    sessionFile,
  };
}

export type EmbeddedModelSelection = Awaited<ReturnType<typeof resolveEmbeddedModelSelection>>;
