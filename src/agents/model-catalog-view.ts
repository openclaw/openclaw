/** Keeps public and private runtime projections on the same captured catalog. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createModelProviderRouteOverrideResolver,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { modelKey as pickerModelKey } from "../shared/model-key.js";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "./model-catalog-browse.js";
import {
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
  type ModelCatalogRouteProjection,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { hasAuthoredProviderRequestParams } from "./model-extra-params.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "./model-visibility-policy.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

/** Indexes physical variants for paired logical catalog projection. */
export function createModelCatalogView(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  routeVariants?: readonly ModelCatalogEntry[];
}) {
  const variantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of params.routeVariants ?? params.catalog) {
    const key = resolveModelCatalogIdentityKey(entry);
    const variants = variantsByKey.get(key) ?? [];
    variants.push(entry);
    variantsByKey.set(key, variants);
  }
  const variantsOf = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    variantsByKey.get(resolveModelCatalogIdentityKey(entry));
  return {
    logicalEntries: dedupeByKey(params.catalog, resolveModelCatalogIdentityKey),
    variantsOf,
    project(entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation) {
      const projection: ModelCatalogRouteProjection =
        evaluation.routeResolution === null
          ? { kind: "unmanaged" }
          : evaluation.selectedRoute
            ? {
                kind: "selected",
                route: evaluation.selectedRoute,
                policy: openAIModelCatalogRoutePolicy,
              }
            : { kind: "unresolved", policy: openAIModelCatalogRoutePolicy };
      const variants = variantsOf(entry);
      const overrides = resolveConfiguredModelCatalogOverrides({
        cfg: params.cfg,
        entry,
        policy: openAIModelCatalogRoutePolicy,
      });
      return projectModelCatalogEntryForRoute({
        entry,
        projection,
        ...(variants ? { catalog: variants } : {}),
        ...(overrides ? { overrides } : {}),
      });
    },
  };
}

export type ModelCatalogViewFacts = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  isCurrent?: () => boolean;
  observationConfig?: OpenClawConfig;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  view?: ModelCatalogBrowseView;
};

/** Projects captured catalog facts while keeping native observations revocable. */
export function prepareModelCatalogView(params: ModelCatalogViewFacts) {
  const defaultModel = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, params.agentId);
  const catalog = [...params.snapshot.entries];
  if (params.view === "configured" && params.snapshot.staticEntries?.length) {
    const { configuredKeys } = createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel,
      agentId: params.agentId,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      manifestPlugins: params.metadataSnapshot,
    });
    const seen = new Set(catalog.map(resolveModelCatalogIdentityKey));
    for (const entry of params.snapshot.staticEntries) {
      const key = resolveModelCatalogIdentityKey(entry);
      if (!seen.has(key) && configuredKeys.has(key)) {
        seen.add(key);
        catalog.push(entry);
      }
    }
  }
  const isCurrent = () => params.isCurrent?.() ?? params.observationConfig === undefined;
  const providerEndpoints = new Map<string, { endpoint?: string; api?: string }>();
  for (const [id, configured] of Object.entries(params.cfg.models?.providers ?? {})) {
    const provider = normalizeProviderId(id);
    if (!providerEndpoints.has(provider)) {
      // Status headers describe provider configuration, not private per-model route provenance.
      providerEndpoints.set(provider, {
        endpoint: normalizeOptionalString(configured.baseUrl),
        api: normalizeOptionalString(configured.api),
      });
    }
  }
  return {
    providerEndpoints,
    snapshot: params.snapshot,
    catalog,
    defaultModel,
    isCurrent,
    evaluateNative: (
      entry: ModelCatalogEntry,
      host: ModelAuthAvailabilityEvaluation,
      runtimeId?: string,
    ): ModelAuthAvailabilityEvaluation => {
      const runtime =
        runtimeId ??
        host.requestedRuntimeId ??
        resolveAgentHarnessPolicy({
          provider: entry.provider,
          modelId: entry.id,
          modelApi: entry.api,
          modelBaseUrl: entry.baseUrl,
          config: params.cfg,
          agentId: params.agentId,
        }).runtime;
      if (runtime === "auto" || runtime === "openclaw") {
        return host;
      }
      const provider = normalizeProviderId(entry.provider);
      const sameProvider =
        !params.profileProvider || normalizeProviderId(params.profileProvider) === provider;
      const configured = resolveMergedModelProviderConfig(params.cfg, provider);
      const modelKey = (id: string) =>
        stripSelfProviderModelPrefix(provider, splitTrailingAuthProfile(id).model.trim()).trim();
      // Native account evidence cannot satisfy an authored host route, key, profile,
      // or request override. Those keep the prepared host evaluation.
      if (
        (sameProvider && params.preferredProfileId) ||
        (sameProvider && params.pinnedProfileId) ||
        (host.selectedAuthMode &&
          (host.evidence !== "runtime" || entry.nativeRuntime !== runtime)) ||
        configured?.api ||
        configured?.baseUrl ||
        configured?.apiKey ||
        configured?.auth ||
        configured?.models?.some(
          (model) => modelKey(model.id) === modelKey(entry.id) && (model.api || model.baseUrl),
        ) ||
        Object.keys(params.cfg.auth?.order ?? {}).some(
          (id) => normalizeProviderId(id) === provider,
        ) ||
        Object.values(params.cfg.auth?.profiles ?? {}).some(
          (profile) => normalizeProviderId(profile.provider) === provider,
        ) ||
        createModelProviderRouteOverrideResolver({
          authoredConfig: params.cfg,
          provider,
        })(entry.id) === "present" ||
        hasAuthoredProviderRequestParams({
          config: params.cfg,
          provider,
          modelId: entry.id,
          agentId: params.agentId,
        })
      ) {
        return host;
      }
      const resolveRegistry = () =>
        params.observationConfig
          ? params.pluginRegistry
          : (params.pluginRegistry ?? getActivePluginRegistry());
      const registry = resolveRegistry();
      const harness = registry?.agentHarnesses.find(
        (registration) => registration.harness.id === runtime,
      )?.harness;
      if (!harness?.readModelCatalogReadiness && entry.nativeRuntime !== runtime) {
        return host;
      }
      let ready: boolean;
      let authMode: string | undefined;
      try {
        ready =
          isCurrent() &&
          harness?.authBootstrap === "harness" &&
          harness.supports({
            provider,
            modelId: entry.id,
            requestedRuntime: runtime,
            modelProvider: { preparedAuth: { source: "harness" } },
          }).supported &&
          isCurrent() &&
          resolveRegistry() === registry;
        const observation = ready
          ? harness?.readModelCatalogReadiness?.({
              config: params.observationConfig ?? params.cfg,
              agentId: params.agentId,
              agentDir,
              workspaceDir: params.workspaceDir,
              provider,
              modelId: entry.id,
            })
          : undefined;
        ready = ready && observation !== undefined && isCurrent() && resolveRegistry() === registry;
        authMode = ready ? observation?.authMode : undefined;
      } catch {
        // A failed/disposed owner supplies no account observation; do not infer host readiness.
        ready = false;
        authMode = undefined;
      }
      return {
        availability: ready,
        availabilityAuthoritative: true,
        routeResolution: null,
        ...(host.requestedRuntimeId ? { requestedRuntimeId: host.requestedRuntimeId } : {}),
        runtimeAuth: { id: runtime, source: "native" },
        ...(authMode ? { selectedAuthMode: authMode } : {}),
      };
    },
    providerInventory(
      sourceConfig: OpenClawConfig,
      canonicalEntries: readonly ModelCatalogEntry[],
    ) {
      const dynamicProviders = new Set(
        params.metadataSnapshot.plugins.flatMap((plugin) =>
          Object.entries(plugin.modelCatalog?.discovery ?? {}).flatMap(([provider, mode]) =>
            mode === "runtime" || mode === "refreshable" ? [normalizeProviderId(provider)] : [],
          ),
        ),
      );
      const discoveryOnlyProviders = new Set(
        Object.entries(sourceConfig.models?.providers ?? {}).flatMap(([provider, config]) => {
          const id = normalizeProviderId(provider);
          return dynamicProviders.has(id) && !Array.isArray(config?.models) ? [id] : [];
        }),
      );
      const canonicalByKey = new Map<string, ModelCatalogEntry>();
      for (const entry of canonicalEntries) {
        const key = resolveModelCatalogIdentityKey(entry);
        if (!canonicalByKey.has(key)) {
          canonicalByKey.set(key, entry);
        }
      }
      // Authored config owns membership; captured catalog rows own route metadata.
      const authored = buildProviderConfigModelCatalogForBrowse({
        cfg: sourceConfig,
        workspaceDir: params.workspaceDir,
      }).map((entry) => canonicalByKey.get(resolveModelCatalogIdentityKey(entry)) ?? entry);
      return dedupeByKey(
        [
          ...authored,
          ...canonicalEntries.filter((entry) =>
            discoveryOnlyProviders.has(normalizeProviderId(entry.provider)),
          ),
        ],
        resolveModelCatalogIdentityKey,
      );
    },
  };
}

type PreparedModelCatalogViewRequest = ModelCatalogViewFacts & {
  kind: "prepared";
  refreshNative?: boolean;
  onError?: (error: unknown) => void;
};

type PickerModelCatalogViewRequest = {
  kind: "picker";
  config: OpenClawConfig;
  preferredProvider?: string;
  preferLiveProviderCatalog?: boolean;
  providerScoped?: boolean;
  allowStaticFallbackCatalog?: boolean;
  includeConfiguredProvider?: (provider: string) => boolean;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

type StatusModelCatalogViewRequest = {
  kind: "status";
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir?: string;
  entries: readonly Pick<ModelCatalogEntry, "provider" | "id">[];
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
};

type StatusModelCatalogView = ReturnType<typeof prepareModelCatalogView> & {
  providerAuthLabels: Map<string, string>;
};

export function loadPreparedModelCatalogView(
  params: PreparedModelCatalogViewRequest,
): Promise<ReturnType<typeof prepareModelCatalogView>>;
export function loadPreparedModelCatalogView(
  params: PickerModelCatalogViewRequest,
): Promise<{ snapshot: ModelCatalogSnapshot }>;
export function loadPreparedModelCatalogView(
  params: StatusModelCatalogViewRequest,
): Promise<StatusModelCatalogView>;
/** Acquires requested catalog facts before constructing a local view. */
export async function loadPreparedModelCatalogView(
  params:
    | PreparedModelCatalogViewRequest
    | PickerModelCatalogViewRequest
    | StatusModelCatalogViewRequest,
): Promise<
  | ReturnType<typeof prepareModelCatalogView>
  | StatusModelCatalogView
  | { snapshot: ModelCatalogSnapshot }
> {
  if (params.kind === "status") {
    const {
      getPublishedPreparedModelCatalogOwnerSnapshot,
      loadPreparedModelCatalogOwnerSnapshot,
      materializePreparedModelCatalogOwner,
    } = await import("./prepared-model-catalog.js");
    const { getPreparedModelRuntimeAuthLabels, getPreparedModelRuntimeAuthStore } =
      await import("./prepared-model-runtime-auth.js");
    const { formatModelCatalogAuthLabel } = await import("./model-catalog-auth-labels.js");
    const { resolveSessionRuntimeOverrideForProvider } =
      await import("./session-runtime-compat.js");
    const { buildAgentRuntimeAuthPlan } = await import("./runtime-plan/auth.js");
    const owner = materializePreparedModelCatalogOwner(
      getPublishedPreparedModelCatalogOwnerSnapshot(params) ??
        (await loadPreparedModelCatalogOwnerSnapshot({ ...params, readOnly: true })),
    );
    const capturedLabels = getPreparedModelRuntimeAuthLabels(owner);
    const store = getPreparedModelRuntimeAuthStore(owner);
    if (!store) {
      throw new Error("Prepared model runtime omitted auth display facts");
    }
    const authContext = { cfg: owner.config, store, metadataSnapshot: owner.metadataSnapshot };
    const providerAuthLabels = new Map<string, string>();
    for (const entry of params.entries) {
      const provider = normalizeProviderId(entry.provider);
      if (providerAuthLabels.has(provider)) {
        continue;
      }
      const runtime =
        resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: params.sessionEntry,
          cfg: owner.config,
        }) ??
        resolveAgentHarnessPolicy({
          provider,
          modelId: entry.id,
          config: owner.config,
          agentId: params.agentId,
        }).runtime;
      const labels = capturedLabels.get(provider);
      let label = formatModelCatalogAuthLabel(
        (provider === "openai" && runtime !== "codex" ? labels?.apiKey : labels?.all) ?? "missing",
        authContext,
      );
      if (label === "missing") {
        const authProvider = buildAgentRuntimeAuthPlan({
          provider,
          config: owner.config,
          workspaceDir: owner.workspaceDir,
          metadataSnapshot: owner.metadataSnapshot,
          harnessRuntime: runtime,
        }).harnessAuthProvider;
        const runtimeLabel = formatModelCatalogAuthLabel(
          (authProvider && authProvider !== provider
            ? capturedLabels.get(authProvider)?.all
            : undefined) ?? "missing",
          authContext,
        );
        if (runtimeLabel !== "missing") {
          label = `via ${runtime} runtime / ${authProvider} ${runtimeLabel}`;
        }
      }
      providerAuthLabels.set(provider, label);
    }
    return {
      ...prepareModelCatalogView({
        cfg: owner.config,
        agentId: params.agentId,
        agentDir: owner.agentDir,
        workspaceDir:
          owner.workspaceDir ??
          params.workspaceDir ??
          resolveAgentWorkspaceDir(owner.config, params.agentId),
        snapshot: owner.modelCatalog,
        metadataSnapshot: owner.metadataSnapshot,
        isCurrent: owner.isCurrent,
      }),
      providerAuthLabels,
    };
  }
  if (params.kind === "prepared") {
    let snapshot = params.snapshot;
    if (params.refreshNative) {
      const { augmentModelCatalogWithAgentHarness } = await import("./harness/model-catalog.js");
      snapshot = await augmentModelCatalogWithAgentHarness({
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
        workspaceDir: params.workspaceDir,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: resolveAgentEffectiveModelPrimary(params.cfg, params.agentId),
        snapshot,
        pluginRegistry: params.pluginRegistry,
        isCurrent: params.isCurrent,
        observationConfig: params.observationConfig,
        onError: params.onError,
      });
      if (snapshot !== params.snapshot) {
        Object.defineProperty(snapshot, "refreshFailed", {
          enumerable: true,
          get: () => params.snapshot.refreshFailed,
        });
      }
    }
    return prepareModelCatalogView({ ...params, snapshot });
  }
  const view = await acquirePickerModelCatalogView(params);
  const includeConfiguredProvider = params.includeConfiguredProvider;
  if (!includeConfiguredProvider) {
    return view;
  }
  const { buildConfiguredModelCatalog } = await import("./model-selection-shared.js");
  let catalog = view.snapshot.entries;
  let configured = buildConfiguredModelCatalog({ cfg: params.config }).filter((entry) =>
    includeConfiguredProvider(entry.provider),
  );
  if (params.preferredProvider && params.providerScoped && catalog.length > 0) {
    const { loadStaticManifestCatalogRowsForList } =
      await import("../commands/models/list.manifest-catalog.js");
    const staticRows = loadStaticManifestCatalogRowsForList({
      cfg: params.config,
      providerFilter: params.preferredProvider,
      ...(params.env !== undefined ? { env: params.env } : {}),
    });
    const keyOf = (entry: { provider: string; id: string }) =>
      pickerModelKey(entry.provider, entry.id);
    const staticKeys = new Set(staticRows.map(keyOf));
    const deprecatedKeys = new Set(
      staticRows.filter((entry) => entry.status === "deprecated").map(keyOf),
    );
    catalog = catalog.filter((entry) => !deprecatedKeys.has(keyOf(entry)));
    configured = configured.filter((entry) => !staticKeys.has(keyOf(entry)));
  }
  const entries = [...catalog];
  const seen = new Set(catalog.map((entry) => pickerModelKey(entry.provider, entry.id)));
  for (const entry of configured) {
    const key = pickerModelKey(entry.provider, entry.id);
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  return {
    snapshot: {
      ...view.snapshot,
      get refreshFailed() {
        return view.snapshot.refreshFailed;
      },
      entries,
    },
  };
}

async function acquirePickerModelCatalogView(
  params: PickerModelCatalogViewRequest,
): Promise<{ snapshot: ModelCatalogSnapshot }> {
  const cfg = params.config;
  const fromEntries = (entries: ModelCatalogEntry[]) => ({
    snapshot: { entries, routeVariants: entries },
  });
  if (cfg.models?.mode === "replace") {
    const { buildConfiguredModelCatalog } = await import("./model-selection-shared.js");
    return fromEntries(buildConfiguredModelCatalog({ cfg }));
  }
  const { loadPreparedModelCatalogSnapshot } = await import("./prepared-model-catalog.js");
  if (params.preferredProvider) {
    if (params.preferLiveProviderCatalog) {
      const { resolveDefaultAgentDir } = await import("./agent-scope.js");
      const { resolvePluginMetadataSnapshot } =
        await import("../plugins/plugin-metadata-snapshot.js");
      const { createPreparedModelCatalogProviderNormalizer } =
        await import("./model-catalog-provider-normalizer.js");
      const requestedProvider = normalizeProviderId(params.preferredProvider);
      if (requestedProvider) {
        const env = params.env ?? process.env;
        const metadataSnapshot = resolvePluginMetadataSnapshot({
          config: cfg,
          env,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        });
        const provider = createPreparedModelCatalogProviderNormalizer(
          metadataSnapshot,
          cfg,
          env,
        )(requestedProvider);
        const acquired = await loadPreparedModelCatalogSnapshot({
          config: cfg,
          agentDir: params.agentDir ?? resolveDefaultAgentDir(cfg, params.env),
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.env ? { env: params.env } : {}),
          readOnly: true,
          providerDiscoveryProviderIds: [provider],
          scopedLiveProviderDiscovery: true,
        });
        const matchesProvider = (entry: { provider: string }) =>
          normalizeProviderId(entry.provider) === provider;
        const entries = acquired.entries.filter(matchesProvider);
        if (entries.length > 0) {
          return {
            snapshot: {
              ...acquired,
              get refreshFailed() {
                return acquired.refreshFailed;
              },
              entries,
              routeVariants: acquired.routeVariants.filter(matchesProvider),
              ...(acquired.staticEntries
                ? { staticEntries: acquired.staticEntries.filter(matchesProvider) }
                : {}),
              ...(acquired.providerOutcomes
                ? { providerOutcomes: acquired.providerOutcomes.filter(matchesProvider) }
                : {}),
            },
          };
        }
      }
    }
    if (!params.preferLiveProviderCatalog || params.allowStaticFallbackCatalog !== false) {
      const { loadStaticManifestCatalogRowsForList } =
        await import("../commands/models/list.manifest-catalog.js");
      const rows = loadStaticManifestCatalogRowsForList({
        cfg,
        providerFilter: params.preferredProvider,
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
      if (rows.length > 0) {
        return fromEntries(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            provider: row.provider,
            api: row.api,
            baseUrl: row.baseUrl,
            contextWindow: row.contextWindow,
            reasoning: row.reasoning,
            input: row.input,
          })),
        );
      }
    }
    if (params.providerScoped) {
      return fromEntries([]);
    }
  }
  return { snapshot: await loadPreparedModelCatalogSnapshot({ config: cfg }) };
}
