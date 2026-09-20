import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { FailoverError } from "./failover/error.js";
import { modelKey, type ModelRef } from "./model-ref-shared.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";

// Cache process-stable modules, not the catalog/auth facts read from each request's owner.
const loadPreparedModelCatalog = createLazyPromise(() => import("./prepared-model-catalog.js"));
const loadModelResolver = createLazyPromise(() => import("./embedded-agent-runner/model.js"));
const loadModelSelection = createLazyPromise(() => import("./model-selection.js"));
const loadModelRefProfile = createLazyPromise(() => import("./model-ref-profile.js"));
const loadModelCatalogDecisions = createLazyPromise(() => import("./model-catalog-decisions.js"));
const loadPreparedRuntimeAuth = createLazyPromise(() => import("./prepared-model-runtime-auth.js"));
const loadProviderModelRoute = createLazyPromise(() => import("./provider-model-route.js"));
const loadRuntimeModelMaterializer = createLazyPromise(
  () => import("./runtime-plan/materialize-model.js"),
);
const loadModelFallbackCandidates = createLazyPromise(
  () => import("./model-fallback-candidates.js"),
);
const loadProviderAuthAliases = createLazyPromise(() => import("./provider-auth-aliases.js"));
const loadPluginGenerationScope = createLazyPromise(
  () => import("../plugins/runtime/generation-scope.js"),
);
const loadModelCatalogEntry = createLazyPromise(() => import("./model-catalog-entry.js"));

type PreparedModelChoice =
  | { kind: "resolved"; ref: ModelRef; model: ProviderRuntimeModel }
  | { kind: "pending"; ref: ModelRef }
  | { kind: "automatic"; ref: ModelRef }
  | { kind: "unavailable"; error: string };

/** Resolve support independently of whether this request needs manual-override permission. */
export async function prepareModelChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  raw: string;
  source: "override" | "automatic";
  resolvedRef?: ModelRef;
  fallbacks?: string[];
}): Promise<PreparedModelChoice> {
  const { withPreparedModelCatalogOwner } = await loadPreparedModelCatalog();
  const { resolveModelAsync } = await loadModelResolver();
  const {
    buildModelAliasIndex,
    resolveAllowedModelRef,
    resolveDefaultModelForAgent,
    resolveModelRefFromString,
  } = await loadModelSelection();
  const { splitTrailingAuthProfile } = await loadModelRefProfile();
  const { createModelCatalogDecisions, resolveCatalogDecisionRuntime } =
    await loadModelCatalogDecisions();
  const { getPreparedModelRuntimeAuthStore } = await loadPreparedRuntimeAuth();
  const { projectProviderModelRouteConfig } = await loadProviderModelRoute();
  const { validatePreparedRuntimeModel } = await loadRuntimeModelMaterializer();
  const { resolveModelCandidateChain } = await loadModelFallbackCandidates();
  const { resolveProviderIdForAuth } = await loadProviderAuthAliases();
  const { withPluginRuntimeGenerationScope } = await loadPluginGenerationScope();
  return await withPreparedModelCatalogOwner(
    {
      config: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      readOnly: true,
    },
    (owner) =>
      withPluginRuntimeGenerationScope(owner, async (): Promise<PreparedModelChoice> => {
        const defaults = resolveDefaultModelForAgent({
          cfg: owner.config,
          agentId: params.agentId,
        });
        const selection = {
          cfg: owner.config,
          agentId: params.agentId,
          defaultProvider: defaults.provider,
          defaultModel: defaults,
          catalog: owner.modelCatalog.entries,
          manifestPlugins: owner.metadataSnapshot.plugins,
          raw: params.raw,
        };
        const selected =
          params.source === "automatic" && params.resolvedRef
            ? { ref: params.resolvedRef }
            : params.source === "override"
              ? resolveAllowedModelRef(selection)
              : resolveModelRefFromString({
                  ...selection,
                  aliasIndex: buildModelAliasIndex(selection),
                });
        if (!selected) {
          return { kind: "unavailable", error: `invalid model: ${params.raw}` };
        }
        if ("error" in selected) {
          return { kind: "unavailable", error: selected.error };
        }
        const requested = selected.ref;
        const authOwner = (provider: string) =>
          resolveProviderIdForAuth(provider, {
            config: owner.config,
            workspaceDir: owner.workspaceDir,
            metadataSnapshot: owner.metadataSnapshot,
          });
        const requestedAuthOwner = authOwner(requested.provider);
        const prepare = async (ref: ModelRef): Promise<PreparedModelChoice> => {
          const authStore = getPreparedModelRuntimeAuthStore(owner);
          if (!authStore) {
            return {
              kind: "unavailable",
              error:
                "Model account facts are not prepared. Retry after configuration finishes loading.",
            };
          }
          const profileId =
            authOwner(ref.provider) === requestedAuthOwner
              ? splitTrailingAuthProfile(params.raw).profile
              : undefined;
          const decisions = createModelCatalogDecisions({
            cfg: owner.config,
            agentId: params.agentId,
            agentDir: owner.agentDir,
            workspaceDir: owner.workspaceDir,
            snapshot: owner.modelCatalog,
            metadataSnapshot: owner.metadataSnapshot,
            preparedAuthStore: authStore,
            preparedRuntimeAuthModes: owner.authModes,
            pluginRegistry: owner.pluginRegistry,
            observationConfig: owner.observationConfig,
            isCurrent: owner.isCurrent,
            preferredProfileId: profileId,
            pinnedProfileId: profileId,
            profileProvider: ref.provider,
          });
          const key = modelKey(ref.provider, ref.model);
          const entry = decisions.snapshot.entries.find(
            (row) => modelKey(row.provider, row.id) === key,
          ) ?? {
            provider: ref.provider,
            id: ref.model,
            name: ref.model,
          };
          const variants = decisions.snapshot.routeVariants.filter(
            (row) => modelKey(row.provider, row.id) === key,
          );
          const host = await decisions.evaluateEntry(entry, variants);
          const auth = decisions.evaluateNative(entry, host);
          if (auth.routeResolution?.kind === "incompatible") {
            return { kind: "unavailable", error: auth.routeResolution.message };
          }
          if ((profileId || auth.availabilityAuthoritative) && auth.availability === false) {
            return {
              kind: "unavailable",
              error: `The selected account or native runtime is unavailable for ${key}. Restore that account before spawning this model.`,
            };
          }
          const selectedRuntime = resolveCatalogDecisionRuntime({
            cfg: owner.config,
            agentId: params.agentId,
            entry,
            evaluation: auth,
            pluginRegistry: owner.pluginRegistry,
          })?.id;
          const config = auth.selectedRoute
            ? projectProviderModelRouteConfig({
                provider: ref.provider,
                config: owner.config,
                route: auth.selectedRoute,
              })
            : owner.config;
          const resolution = await resolveModelAsync(
            ref.provider,
            ref.model,
            owner.agentDir,
            config,
            {
              agentId: params.agentId,
              workspaceDir: owner.workspaceDir,
              preparedModelRuntime: owner,
              modelIdSource: "selected",
              authProfileId: auth.selectedProfileId,
              authProfileMode: resolveProviderModelMaterializationAuthMode(auth.selectedAuthMode),
              ...(selectedRuntime ? { agentRuntimeId: selectedRuntime } : {}),
              allowBundledStaticCatalogFallback: true,
              deferProviderDynamicModelPreparation: params.source === "automatic",
            },
          );
          if (!decisions.isCurrent()) {
            return {
              kind: "unavailable",
              error: "Model configuration changed during selection. Retry the request.",
            };
          }
          if (resolution.model) {
            try {
              const model = validatePreparedRuntimeModel({
                provider: ref.provider,
                modelId: ref.model,
                config,
                workspaceDir: owner.workspaceDir,
                metadataSnapshot: owner.metadataSnapshot,
                route: auth.selectedRoute
                  ? { ...auth.selectedRoute, provider: ref.provider, modelId: ref.model }
                  : undefined,
                model: resolution.model,
              });
              return { kind: "resolved", ref: resolution.logicalRef, model };
            } catch (error) {
              // A retired final route rejects this candidate, not its remaining fallbacks.
              if (error instanceof FailoverError && error.reason === "model_not_found") {
                return { kind: "unavailable", error: error.message };
              }
              throw error;
            }
          }
          // Automatic choices must not turn an unobserved dynamic catalog into a network probe.
          return resolution.deferred === "provider-dynamic-model"
            ? { kind: "pending", ref }
            : { kind: "unavailable", error: resolution.error };
        };
        const choice = await prepare(requested);
        if (params.source !== "automatic" || choice.kind !== "unavailable") {
          return choice;
        }
        const fallbacks = resolveModelCandidateChain({
          cfg: owner.config,
          agentId: params.agentId,
          provider: requested.provider,
          model: requested.model,
          requestedRouteResolution: "resolved",
          allowPluginNormalization: false,
          manifestPlugins: owner.metadataSnapshot.plugins,
          fallbacksOverride: params.fallbacks ?? [],
        }).slice(1);
        const choices = await Promise.all(fallbacks.map(prepare));
        if (!owner.isCurrent()) {
          return {
            kind: "unavailable",
            error: "Model configuration changed during selection. Retry the request.",
          };
        }
        return choices.some((fallback) => fallback.kind !== "unavailable")
          ? { kind: "automatic", ref: requested }
          : choice;
      }),
  );
}

/** Bind runtime selection and its commit check to the current published model owner. */
export async function preparePublishedModelRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  runtimeId: string;
  sessionEntry?: Pick<
    SessionEntry,
    "authProfileOverride" | "authProfileOverrideSource" | "providerOverride" | "modelProvider"
  >;
}): Promise<
  { kind: "unavailable"; message: string } | { kind: "ready"; validate: () => string | undefined }
> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await loadPreparedModelCatalog();
  const { getPreparedModelRuntimeAuthStore } = await loadPreparedRuntimeAuth();
  const { createModelCatalogDecisions } = await loadModelCatalogDecisions();
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  const unavailable = `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`;
  if (!published) {
    return { kind: "unavailable", message: unavailable };
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    return { kind: "unavailable", message: unavailable };
  }
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
    agentId: owner.agentId ?? params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: params.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      params.sessionEntry?.authProfileOverrideSource === "user"
        ? params.sessionEntry.authProfileOverride
        : undefined,
    profileProvider: params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider,
  });
  let entry = decisions.snapshot.entries.find(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  if (!entry) {
    // Explicit selections may be outside finite browse inventory. The normal
    // resolver still owns the requested model's provider and physical route.
    const { resolveModelAsync } = await loadModelResolver();
    const { modelCatalogRowToEntry } = await loadModelCatalogEntry();
    const selectedAuth = await decisions.evaluateEntry(
      { provider: params.provider, id: params.model },
      undefined,
      params.runtimeId,
    );
    const authProfileMode = resolveProviderModelMaterializationAuthMode(
      selectedAuth.selectedAuthMode,
    );
    if (selectedAuth.availability !== true || !authProfileMode) {
      return { kind: "unavailable", message: unavailable };
    }
    const resolved = await resolveModelAsync(
      params.provider,
      params.model,
      owner.agentDir,
      owner.config,
      {
        agentId: owner.agentId ?? params.agentId,
        workspaceDir: owner.workspaceDir,
        preparedModelRuntime: owner,
        agentRuntimeId: params.runtimeId,
        allowBundledStaticCatalogFallback: true,
        // Discovery must retain the prepared account instead of rereading live auth stores.
        authProfileMode,
        ...(selectedAuth.selectedProfileId
          ? { authProfileId: selectedAuth.selectedProfileId }
          : {}),
      },
    );
    if (!resolved.model) {
      return { kind: "unavailable", message: unavailable };
    }
    entry = modelCatalogRowToEntry(resolved.model);
  }
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => modelKey(row.provider, row.id) === modelKey(entry.provider, entry.id),
  );
  const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
  if (!choices?.includes(params.runtimeId)) {
    return { kind: "unavailable", message: unavailable };
  }
  const host = await decisions.evaluateEntry(
    entry,
    variants.length ? variants : [entry],
    params.runtimeId,
  );
  const validate = () =>
    decisions.isCurrent() &&
    decisions.evaluateNative(entry, host, params.runtimeId).availability === true
      ? undefined
      : unavailable;

  return { kind: "ready", validate };
}
