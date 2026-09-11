/**
 * Discovers implicit model-provider config from plugin provider catalogs and
 * static catalogs. It merges discovered provider models with explicit config
 * while preserving user-controlled provider fields.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { getConfigProviderUseBindings } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  prepareProviderStaticCatalog,
  resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog,
  type PreparedProviderStaticCatalog,
} from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import { prepareProviderExternalAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveManifestSyntheticAuthProviderRefState } from "../plugins/synthetic-auth.runtime.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "./model-auth-markers.js";
import { resolveStartupProviderUseBindingConflict } from "./model-auth-runtime-config.js";
import { parseConfiguredModelVisibilityEntries } from "./model-selection-shared.js";
import { mergeProviderModels, type SourceModelFields } from "./models-config.merge.js";
import {
  buildPluginCatalogConfig,
  resolveCatalogProviderUseAdmission,
  runProviderCatalogWithTimeout,
} from "./models-config.providers.catalog-context.js";
import {
  resolveImplicitProviderDiscoveryScope,
  type ProviderDiscoveryScope,
} from "./models-config.providers.discovery-scope.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
} from "./models-config.providers.secrets.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secrets.js";
import type { ProviderUseBinding } from "./provider-model-auth-source-plan.js";

const PROVIDER_IMPLICIT_MERGERS: Partial<
  Record<
    string,
    (params: { existing: ProviderConfig | undefined; implicit: ProviderConfig }) => ProviderConfig
  >
> = {
  ollama: ({ implicit }) => implicit,
};

const PLUGIN_DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

type ImplicitProviderParams = {
  agentDir: string;
  authStore?: AuthProfileStore;
  config?: OpenClawConfig;
  discoveryAuthConfig?: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerDiscoveryProviderIds?: readonly string[];
  requestedProviderIds?: readonly string[];
  staticCatalogProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  onProviderCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
  sourceModelFields?: SourceModelFields;
};

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  providerDiscoveryScope?: ProviderDiscoveryScope;
  resolveProviderApiKey: ProviderApiKeyResolver;
  resolveProviderAuth: ProviderAuthResolver;
  providerAdmission: ReadonlyMap<string, ProviderUseBinding>;
  liveProviderIds: Set<string>;
  publicStaticProviders: Map<string, ProviderConfig>;
};

function resolveLiveProviderCatalogTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return null;
  }
  const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
  if (!raw) {
    return 15_000;
  }
  const parsed = Number(raw);
  return /^[+]?\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 15_000;
}

function mergeImplicitProviderSet(
  target: Record<string, ProviderConfig>,
  additions: Record<string, ProviderConfig> | undefined,
): void {
  if (!additions) {
    return;
  }
  for (const [key, value] of Object.entries(additions)) {
    target[key] = value;
  }
}

function mergeImplicitProviderConfig(params: {
  providerId: string;
  existing: ProviderConfig | undefined;
  implicit: ProviderConfig;
  dynamicProviderModels?: boolean;
  sourceModelFields?: SourceModelFields;
}): ProviderConfig {
  const { providerId, existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  const merge = PROVIDER_IMPLICIT_MERGERS[providerId];
  if (merge) {
    return merge({ existing, implicit });
  }
  return mergeProviderModels(implicit, existing, {
    providerId,
    sourceModelFields: params.sourceModelFields,
    preserveConfiguredModelMembership:
      !params.dynamicProviderModels && Array.isArray(existing.models) && existing.models.length > 0,
  });
}

function resolveImplicitProviderAuthMarker(params: {
  ctx: ImplicitProviderContext;
  providerId: string;
  provider: ProviderConfig;
}): ProviderConfig {
  return resolveMissingProviderApiKey({
    providerKey: params.providerId,
    provider: params.provider,
    env: params.ctx.env,
    profileApiKey: undefined,
  });
}

function resolveConfiguredImplicitProvider(params: {
  configuredProviders?: Record<string, ProviderConfig> | null;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  for (const providerId of params.providerIds) {
    const configured = findNormalizedProviderValue(
      params.configuredProviders ?? undefined,
      providerId,
    );
    if (configured) {
      return configured;
    }
  }
  return undefined;
}

function resolveExistingImplicitProviderFromContext(params: {
  ctx: ImplicitProviderContext;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  return (
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.explicitProviders,
      providerIds: params.providerIds,
    }) ??
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.config?.models?.providers,
      providerIds: params.providerIds,
    })
  );
}

function hasProviderWildcardVisibility(params: {
  config?: OpenClawConfig;
  providerId: string;
}): boolean {
  return parseConfiguredModelVisibilityEntries({ cfg: params.config }).providerWildcards.has(
    normalizeProviderId(params.providerId),
  );
}

function hasRuntimeProviderCatalog(
  provider: import("../plugins/types.js").ProviderPlugin,
): boolean {
  return typeof provider.catalog?.run === "function";
}

async function resolvePluginImplicitProviders(
  ctx: ImplicitProviderContext,
  providers: import("../plugins/types.js").ProviderPlugin[],
  order: import("../plugins/types.js").ProviderCatalogOrder,
  preparedStaticResults?: ReadonlyMap<
    import("../plugins/types.js").ProviderPlugin,
    PreparedProviderStaticCatalog["entries"][number]["result"]
  >,
): Promise<Record<string, ProviderConfig> | undefined> {
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const discovered: Record<string, ProviderConfig> = {};
  const selectedProviderIds = ctx.providerDiscoveryScope
    ? new Set([...ctx.providerDiscoveryScope.values()].flat())
    : undefined;
  const catalogCountsByPluginId = new Map<string, number>();
  for (const provider of providers) {
    if (!provider.catalog && !provider.staticCatalog) {
      continue;
    }
    const pluginId = provider.pluginId ?? normalizeProviderId(provider.id);
    catalogCountsByPluginId.set(pluginId, (catalogCountsByPluginId.get(pluginId) ?? 0) + 1);
  }
  for (const provider of byOrder[order]) {
    const pluginId = provider.pluginId ?? normalizeProviderId(provider.id);
    const ownerProviderIds = ctx.providerDiscoveryScope?.get(pluginId);
    const manifest = ctx.pluginMetadataSnapshot?.manifestRegistry.plugins.find(
      (plugin) => plugin.id === pluginId,
    );
    const includeProvider = (providerId: string) =>
      isProviderCatalogSourceAllowed({
        provider: providerId,
        config: ctx.config,
        plugin: manifest,
      });
    const scopedProviderIds =
      ctx.providerDiscoveryScope === undefined
        ? undefined
        : catalogCountsByPluginId.get(pluginId) === 1
          ? (ownerProviderIds ?? [])
          : (ownerProviderIds ?? []).filter((id) => matchesProviderPluginRef(provider, id));
    const providerIds = scopedProviderIds?.filter(includeProvider);
    const catalogProviderRefs = [
      provider.id,
      ...(provider.aliases ?? []),
      ...(provider.hookAliases ?? []),
      ...(catalogCountsByPluginId.get(pluginId) === 1 ? (manifest?.providers ?? []) : []),
    ];
    if (
      providerIds?.length === 0 ||
      (providerIds === undefined && !catalogProviderRefs.some(includeProvider))
    ) {
      continue;
    }
    const admittedProviderIds = (providerIds ?? catalogProviderRefs).filter((id) =>
      ctx.providerAdmission.has(normalizeProviderId(id)),
    );
    const catalogConfig = buildPluginCatalogConfig(ctx, provider);
    const resolveCatalogProviderApiKey = (providerId?: string) => {
      const resolvedProviderId = providerId?.trim() || provider.id;
      const resolved = ctx.resolveProviderApiKey(resolvedProviderId);
      if (
        resolved.apiKey ||
        ctx.providerAdmission.get(normalizeProviderId(resolvedProviderId))?.kind === "profile"
      ) {
        return resolved;
      }

      if (
        !findNormalizedProviderValue(
          {
            [provider.id]: true,
            ...Object.fromEntries((provider.aliases ?? []).map((alias) => [alias, true])),
            ...Object.fromEntries((provider.hookAliases ?? []).map((alias) => [alias, true])),
          },
          resolvedProviderId,
        )
      ) {
        return resolved;
      }

      const synthetic = provider.resolveSyntheticAuth?.({
        config: catalogConfig,
        provider: resolvedProviderId,
        providerConfig: catalogConfig.models?.providers?.[resolvedProviderId],
      });
      const syntheticApiKey = synthetic?.apiKey?.trim();
      if (!syntheticApiKey) {
        return resolved;
      }

      return {
        apiKey: isNonSecretApiKeyMarker(syntheticApiKey)
          ? syntheticApiKey
          : resolveNonEnvSecretRefApiKeyMarker("file"),
        discoveryApiKey: undefined,
      };
    };

    if (ctx.providerDiscoveryEntriesOnly === true && !provider.staticCatalog) {
      // Mandatory startup accepts only provider facts that do not execute live discovery.
      continue;
    }
    const useStaticCatalog =
      Boolean(provider.staticCatalog) &&
      (ctx.providerDiscoveryEntriesOnly === true || !hasRuntimeProviderCatalog(provider));
    // Static catalogs are preferred for entries-only discovery and as a fallback
    // when runtime discovery produces no usable provider config.
    const hasPreparedStaticResult = preparedStaticResults?.has(provider) === true;
    let staticResult = useStaticCatalog;
    let result;
    if (useStaticCatalog) {
      result = hasPreparedStaticResult
        ? preparedStaticResults.get(provider)
        : await runProviderStaticCatalog({ provider });
    } else if (admittedProviderIds.length > 0) {
      const currentProviderIds = admittedProviderIds.filter((providerId) => {
        if (
          !resolveStartupProviderUseBindingConflict({
            ...ctx,
            provider: providerId,
            cfg: ctx.config,
            store: ctx.authStore,
          })
        ) {
          return true;
        }
        ctx.onProviderCatalogOutcome?.({ provider: providerId, status: "unavailable" });
        return false;
      });
      currentProviderIds.forEach((id) => ctx.liveProviderIds.add(normalizeProviderId(id)));
      result = await runProviderCatalogWithTimeout({
        provider,
        providerIds: currentProviderIds,
        admission: ctx.providerAdmission,
        resolveProviderApiKey: resolveCatalogProviderApiKey,
        resolveProviderAuth: ctx.resolveProviderAuth,
        reportCatalogOutcome: ctx.onProviderCatalogOutcome,
        authStore: ctx.authStore,
        config: catalogConfig,
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        env: ctx.env,
        timeoutMs: ctx.providerDiscoveryTimeoutMs ?? resolveLiveProviderCatalogTimeoutMs(ctx.env),
      });
    }
    if (!result && !useStaticCatalog && provider.staticCatalog) {
      staticResult = true;
      result = await runProviderStaticCatalog({ provider });
    }
    if (!result) {
      continue;
    }
    const normalizedResult = normalizePluginDiscoveryResult({
      provider,
      result,
    });
    for (const [providerId, implicitProvider] of Object.entries(normalizedResult)) {
      if (
        !includeProvider(providerId) ||
        (selectedProviderIds && !selectedProviderIds.has(normalizeProviderId(providerId)))
      ) {
        continue;
      }
      if (staticResult) {
        ctx.publicStaticProviders.set(providerId, implicitProvider);
      }
      const mergedProvider = mergeImplicitProviderConfig({
        providerId,
        existing:
          discovered[providerId] ??
          resolveExistingImplicitProviderFromContext({
            ctx,
            providerIds: [
              providerId,
              provider.id,
              ...(provider.aliases ?? []),
              ...(provider.hookAliases ?? []),
            ],
          }),
        implicit: implicitProvider,
        dynamicProviderModels: hasProviderWildcardVisibility({
          config: ctx.config,
          providerId,
        }),
        sourceModelFields: ctx.sourceModelFields,
      });
      discovered[providerId] = resolveImplicitProviderAuthMarker({
        ctx,
        providerId,
        provider: mergedProvider,
      });
    }
  }
  return Object.keys(discovered).length > 0 ? discovered : undefined;
}

/** Prepares sterile provider catalog results for one workspace/config generation. */
export async function prepareImplicitProviderStaticCatalog(
  params: Pick<
    ImplicitProviderParams,
    | "config"
    | "env"
    | "pluginMetadataSnapshot"
    | "providerDiscoveryProviderIds"
    | "staticCatalogProviderIds"
    | "workspaceDir"
  >,
): Promise<PreparedProviderStaticCatalog> {
  const env = params.env ?? process.env;
  const discoveryScope = resolveImplicitProviderDiscoveryScope(params);
  const providers = await resolveRuntimePluginDiscoveryProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: discoveryScope ? [...discoveryScope.keys()] : undefined,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    discoveryEntriesOnly: true,
    includeSyntheticAuthProviders: true,
  });
  const staticCatalogProviderIds = params.staticCatalogProviderIds
    ? new Set(params.staticCatalogProviderIds.map((provider) => normalizeProviderId(provider)))
    : undefined;
  const eligibleProviders = providers.filter((provider) => {
    const pluginId = provider.pluginId ?? normalizeProviderId(provider.id);
    const plugin = params.pluginMetadataSnapshot?.manifestRegistry.plugins.find(
      (candidate) => candidate.id === pluginId,
    );

    const soleStaticCatalog =
      providers.filter(
        (candidate) =>
          (candidate.pluginId ?? normalizeProviderId(candidate.id)) === pluginId &&
          candidate.staticCatalog,
      ).length === 1;
    const providerRefs = discoveryScope?.get(pluginId) ?? [
      provider.id,
      ...(provider.aliases ?? []),
      ...(provider.hookAliases ?? []),
      ...(soleStaticCatalog ? (plugin?.providers ?? []) : []),
    ];
    // A shared static hook can still serve an eligible selected sibling identity.
    return providerRefs.some(
      (providerRef) =>
        (soleStaticCatalog || matchesProviderPluginRef(provider, providerRef)) &&
        isProviderCatalogSourceAllowed({ provider: providerRef, config: params.config, plugin }),
    );
  });
  const prepared = await prepareProviderStaticCatalog({
    providers: staticCatalogProviderIds
      ? eligibleProviders.filter((provider) => {
          if ([...staticCatalogProviderIds].some((id) => matchesProviderPluginRef(provider, id))) {
            return true;
          }
          const ownerProviderIds = provider.pluginId
            ? discoveryScope?.get(provider.pluginId)
            : undefined;
          // A family can publish several identities from one static hook without aliases.
          return (
            ownerProviderIds?.some((id) => staticCatalogProviderIds.has(id)) === true &&
            providers.filter(
              (candidate) => candidate.pluginId === provider.pluginId && candidate.staticCatalog,
            ).length === 1
          );
        })
      : eligibleProviders,
  });
  // Synthetic auth consumes the complete configured provider entrypoint set. Static results may
  // be narrower because startup only executes hooks for unresolved configured model refs.
  return Object.freeze({
    providers: Object.freeze(providers),
    // Record excluded hooks as empty so later static consumers cannot execute them again.
    entries: Object.freeze([
      ...prepared.entries.map((entry) => {
        const plugin = params.pluginMetadataSnapshot?.manifestRegistry.plugins.find(
          (candidate) => candidate.id === (entry.provider.pluginId ?? entry.provider.id),
        );
        const providerEntries = Object.entries(normalizePluginDiscoveryResult(entry));
        const eligible = providerEntries.filter(([provider]) =>
          isProviderCatalogSourceAllowed({ provider, config: params.config, plugin }),
        );
        return eligible.length === providerEntries.length
          ? entry
          : { provider: entry.provider, result: { providers: Object.fromEntries(eligible) } };
      }),
      ...providers
        .filter((provider) => provider.staticCatalog && !eligibleProviders.includes(provider))
        .map((provider) => ({ provider, result: { providers: {} } })),
    ]),
  });
}

/** Resolve all implicit provider configs contributed by runtime plugin discovery. */
export async function resolveImplicitProviders(
  params: ImplicitProviderParams,
): Promise<NonNullable<OpenClawConfig["models"]>["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const env = params.env ?? process.env;
  let authStore = params.authStore;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
      externalCliProviderIds: params.providerDiscoveryProviderIds,
    }));
  const discoveryScope = resolveImplicitProviderDiscoveryScope(params);
  const discoveryPluginIds = discoveryScope ? [...discoveryScope.keys()] : undefined;
  // The runtime config has already resolved SecretRefs at its owning boundary.
  // Re-resolving source refs here would execute unrelated file/exec providers on catalog reads.
  const discoveryAuthConfig = params.discoveryAuthConfig ?? params.config;
  const discoveryAuthEnv = params.discoveryAuthEnv ?? env;
  const sourceConfigForSecrets = params.providerDiscoveryEntriesOnly
    ? undefined
    : (params.sourceConfigForSecrets ?? params.config);
  const providerAdmission = resolveCatalogProviderUseAdmission({
    ...params,
    env,
    profiles: params.providerDiscoveryEntriesOnly ? undefined : getAuthStore().profiles,
  });
  const provisionalOutcomes: ProviderCatalogOutcome[] = [];
  const startupBindings = getConfigProviderUseBindings(params.config);
  const authInputs = [
    env,
    getAuthStore,
    discoveryAuthConfig,
    sourceConfigForSecrets,
    params.workspaceDir,
    discoveryAuthEnv,
    providerAdmission,
  ] as const;
  const context: ImplicitProviderContext = {
    ...params,
    get authStore() {
      return getAuthStore();
    },
    env,
    ...(discoveryScope ? { providerDiscoveryScope: discoveryScope } : {}),
    resolveProviderApiKey: createProviderApiKeyResolver(...authInputs),
    resolveProviderAuth: createProviderAuthResolver(...authInputs),
    providerAdmission,
    liveProviderIds: new Set(),
    publicStaticProviders: new Map(),
    onProviderCatalogOutcome: (outcome) => {
      if (Object.hasOwn(startupBindings, normalizeProviderId(outcome.provider))) {
        provisionalOutcomes.push(outcome);
      } else {
        params.onProviderCatalogOutcome?.(outcome);
      }
    },
  };
  const preparedStaticEntries = params.preparedStaticProviderCatalog
    ? params.preparedStaticProviderCatalog.entries.filter(
        ({ provider }) =>
          discoveryPluginIds === undefined ||
          (provider.pluginId !== undefined && discoveryPluginIds.includes(provider.pluginId)),
      )
    : undefined;
  const preparedProviders =
    params.providerDiscoveryEntriesOnly === true && params.preparedStaticProviderCatalog?.providers
      ? params.preparedStaticProviderCatalog.providers.filter(
          (provider) =>
            discoveryPluginIds === undefined ||
            (provider.pluginId !== undefined && discoveryPluginIds.includes(provider.pluginId)),
        )
      : [];
  const preparedPluginIds = new Set(
    preparedProviders.flatMap((provider) => (provider.pluginId ? [provider.pluginId] : [])),
  );
  const missingDiscoveryPluginIds =
    discoveryPluginIds?.filter((pluginId) => !preparedPluginIds.has(pluginId)) ??
    (preparedProviders.length > 0 ? undefined : discoveryPluginIds);
  const resolvedProviders =
    missingDiscoveryPluginIds === undefined || missingDiscoveryPluginIds.length > 0
      ? await resolveRuntimePluginDiscoveryProviders({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env,
          onlyPluginIds: missingDiscoveryPluginIds,
          ...(params.pluginMetadataSnapshot
            ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
          ...(params.providerDiscoveryEntriesOnly === true ? { discoveryEntriesOnly: true } : {}),
        })
      : [];
  const discoveryProviders = [
    ...new Map(
      [...resolvedProviders, ...preparedProviders].map((provider) => [
        `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`,
        provider,
      ]),
    ).values(),
  ];
  const syntheticRefs = resolveManifestSyntheticAuthProviderRefState({
    config: discoveryAuthConfig,
    env,
    workspaceDir: params.workspaceDir,
    ...(params.pluginMetadataSnapshot ? { index: params.pluginMetadataSnapshot.index } : {}),
  }).refs.map(normalizeProviderId);
  const syntheticProviders = discoveryProviders.filter((provider) =>
    syntheticRefs.some((ref) => matchesProviderPluginRef(provider, ref)),
  );
  const configuredSyntheticRefs = Object.entries(
    discoveryAuthConfig?.models?.providers ?? {},
  ).flatMap(([provider, { api }]) =>
    api &&
    (syntheticRefs.includes(normalizeProviderId(api)) ||
      syntheticProviders.some((candidate) => matchesProviderPluginRef(candidate, api)))
      ? [normalizeProviderId(provider)]
      : [],
  );
  const scopedRefs = discoveryScope ? new Set([...discoveryScope.values()].flat()) : undefined;
  // Prepare declared native refs and their configured API aliases without reopening
  // unrelated discovery. Already-resolved descriptors retain hook-alias matching.
  for (const provider of new Set([...syntheticRefs, ...configuredSyntheticRefs])) {
    if (scopedRefs && !scopedRefs.has(provider)) {
      continue;
    }
    await prepareProviderExternalAuthWithPlugin({
      config: discoveryAuthConfig,
      env: discoveryAuthEnv,
      workspaceDir: params.workspaceDir,
      provider,
      context: {
        config: discoveryAuthConfig,
        provider,
        providerConfig: findNormalizedProviderValue(
          discoveryAuthConfig?.models?.providers,
          provider,
        ),
      },
    });
  }
  const hasLiveCatalog = discoveryProviders.some(hasRuntimeProviderCatalog);
  if (params.providerDiscoveryEntriesOnly !== true && hasLiveCatalog) {
    const { prepareProviderDiscoveryAuth } =
      await import("./models-config.providers.discovery-auth.runtime.js");
    Object.assign(context, await prepareProviderDiscoveryAuth(context, discoveryAuthConfig));
  }
  const preparedStaticResultsByProvider = new Map(
    preparedStaticEntries?.map(({ provider, result }) => [
      `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`,
      result,
    ]) ?? [],
  );
  const preparedStaticResults = params.preparedStaticProviderCatalog
    ? new Map(
        discoveryProviders.flatMap((provider) => {
          const key = `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`;
          return preparedStaticResultsByProvider.has(key)
            ? [[provider, preparedStaticResultsByProvider.get(key)] as const]
            : [];
        }),
      )
    : undefined;
  for (const order of PLUGIN_DISCOVERY_ORDERS) {
    mergeImplicitProviderSet(
      providers,
      await resolvePluginImplicitProviders(
        context,
        discoveryProviders,
        order,
        preparedStaticResults,
      ),
    );
  }
  const revoked = new Set<string>();
  for (const provider of context.liveProviderIds) {
    if (
      !resolveStartupProviderUseBindingConflict({
        ...context,
        provider,
        cfg: params.config,
        store: getAuthStore(),
      })
    ) {
      continue;
    }
    revoked.add(provider);
    const publicStatic = context.publicStaticProviders.get(provider);
    if (publicStatic) {
      providers[provider] = publicStatic;
    } else {
      delete providers[provider];
    }
  }
  for (const outcome of provisionalOutcomes) {
    if (!revoked.has(normalizeProviderId(outcome.provider))) {
      params.onProviderCatalogOutcome?.(outcome);
    }
  }
  for (const provider of revoked) {
    params.onProviderCatalogOutcome?.({ provider, status: "unavailable" });
  }
  return providers;
}
