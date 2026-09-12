import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import pLimit from "p-limit";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
  type PreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import {
  assertPreparedModelRuntimeInputCurrent,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  preparedModelInventoryKey,
} from "./prepared-model-runtime.facts.js";
import {
  type PreparedModelRuntimeCatalogAccess,
  isPreparedModelCatalogFull,
  markPreparedModelCatalogFull,
  materializePreparedModelCatalog,
  mergePreparedNativeCatalog,
  prepareModelCatalogPublication,
} from "./prepared-model-runtime.full-catalog.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { createCatalogAttemptReporter } from "./prepared-model-runtime.publication-events.js";
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelCatalogRefreshOptions,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

export const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);
const MODEL_CATALOG_FOREGROUND_WAIT_MS = 5_000;
const log = createSubsystemLogger("agents/prepared-model-runtime");

export function refreshCommittedProviderCatalogs(
  owners: Iterable<PreparedModelRuntimeOwner>,
): void {
  for (const owner of owners) {
    if (owner.provenance !== "configured" || owner.pending || owner.needsRefresh) {
      continue;
    }
    void owner.snapshot?.loadFullModelCatalog?.({ changedOnly: true }).catch((error: unknown) => {
      if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        log.warn(`provider catalog refresh failed: ${String(error)}`);
      }
    });
  }
}

function preparedProviderCatalogSource(
  facts: PreparedModelRuntimeAgentFacts,
  generation: PreparedModelRuntimePluginGeneration,
  provider: string,
  normalize: (provider: string) => string,
): string {
  const { config } = facts.input;
  const pluginIds = generation.pluginMetadataSnapshot.owners.providers.get(provider) ?? [];
  const providerEntries = <T>(entries: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(entries ?? {}).filter(([id]) => normalize(id) === provider));
  return fingerprintPreparedRuntimeFacts({
    models: { ...config.models, providers: providerEntries(config.models?.providers) },
    auth: {
      profiles: Object.fromEntries(
        Object.entries(config.auth?.profiles ?? {}).filter(
          ([, profile]) => normalize(profile.provider) === provider,
        ),
      ),
      order: providerEntries(config.auth?.order),
    },
    plugins: {
      ...config.plugins,
      allow: config.plugins?.allow?.filter((id) => pluginIds.includes(id)),
      deny: config.plugins?.deny?.filter((id) => pluginIds.includes(id)),
      entries: Object.fromEntries(pluginIds.map((id) => [id, config.plugins?.entries?.[id]])),
    },
    env: { config: config.env, runtime: facts.env },
  });
}

function preparedProviderCatalogCredentials(
  source: Pick<PreparedModelCatalogAuth, "authStore" | "credentials">,
  provider: string,
  normalize: (provider: string) => string,
): string {
  const { authStore, credentials } = source;
  return fingerprintPreparedRuntimeFacts({
    profiles: Object.fromEntries(
      Object.entries(authStore.profiles).filter(
        ([, profile]) => normalize(profile.provider) === provider,
      ),
    ),
    credentials: Object.fromEntries(
      Object.entries(credentials ?? {}).filter(([id]) => normalize(id) === provider),
    ),
    order: Object.fromEntries(
      Object.entries(authStore.order ?? {}).filter(([id]) => normalize(id) === provider),
    ),
  });
}

function filterPreparedProviderCatalog(
  catalog: ModelCatalogSnapshot,
  includesProvider: (provider: string) => boolean,
): ModelCatalogSnapshot {
  return {
    ...catalog,
    entries: catalog.entries.filter((entry) => includesProvider(entry.provider)),
    routeVariants: catalog.routeVariants.filter((entry) => includesProvider(entry.provider)),
    staticEntries: catalog.staticEntries?.filter((entry) => includesProvider(entry.provider)),
    providerOutcomes: catalog.providerOutcomes?.filter((outcome) =>
      includesProvider(outcome.provider),
    ),
  };
}

function mergePreparedProviderCatalog(
  previous: ModelCatalogSnapshot | undefined,
  discovered: ModelCatalogSnapshot,
  providers: ReadonlySet<string>,
  normalize: (provider: string) => string,
): ModelCatalogSnapshot {
  const retained =
    previous &&
    filterPreparedProviderCatalog(previous, (provider) => !providers.has(normalize(provider)));
  const scoped = filterPreparedProviderCatalog(discovered, (provider) =>
    providers.has(normalize(provider)),
  );
  const outcomes = [...(retained?.providerOutcomes ?? []), ...(scoped.providerOutcomes ?? [])];
  return {
    ...scoped,
    entries: [...(retained?.entries ?? []), ...scoped.entries],
    routeVariants: [...(retained?.routeVariants ?? []), ...scoped.routeVariants],
    staticEntries: [...(retained?.staticEntries ?? []), ...(scoped.staticEntries ?? [])],
    providerOutcomes: outcomes,
    authoritative: outcomes.every((outcome) => outcome.status === "ready"),
  };
}

export function createFullModelCatalogAccess(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  catalogFacts: PreparedModelRuntimeCatalogFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  isCurrent: () => boolean;
  inventoryOwner: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "catalogAttempt">;
}): PreparedModelRuntimeCatalogAccess {
  let currentConfiguredRuntimeModels = params.catalogFacts.configuredRuntimeModels;
  // Retain discovery, not the retired worker or its runtime capability projection.
  const project = (catalog: ModelCatalogSnapshot) => {
    const configured = prepareConfiguredRuntimeFacts({
      agentFacts: params.agentFacts,
      workspaceFacts: params.pluginGeneration,
      templateModelRegistry: params.catalogFacts.templateModelRegistry,
      configuredRuntimeModels: currentConfiguredRuntimeModels,
    }).modelCatalog;
    const current = materializePreparedModelCatalog(
      configured,
      params.agentFacts.runtimeCapabilityModels,
    );
    const projected = materializePreparedModelCatalog(
      catalog,
      params.agentFacts.runtimeCapabilityModels,
      current.staticEntries,
    );
    projected.entries = dedupeByKey(
      [...projected.entries, ...current.entries],
      resolveModelCatalogIdentityKey,
    );
    projected.routeVariants = dedupeByKey(
      [...projected.routeVariants, ...current.routeVariants],
      (entry) =>
        JSON.stringify([
          resolveModelCatalogIdentityKey(entry),
          entry.api,
          entry.baseUrl,
          entry.nativeRuntime,
        ]),
    );
    prepareModelCatalogThinkingPolicies({
      catalog: projected,
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      providers: params.pluginGeneration.pluginRegistry?.providers,
    });
    return attempt.withRefreshStatus(projected);
  };
  const inventoryKey = preparedModelInventoryKey(params.agentFacts.input);
  const nativeSource = fingerprintPreparedRuntimeFacts({
    runtimePluginSelections: params.agentFacts.input.runtimePluginSelections,
    agents: params.agentFacts.input.config.agents,
    plugins: params.agentFacts.input.config.plugins,
    configuredModelRefs: params.agentFacts.configuredModelRefs,
  });
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    params.pluginGeneration.pluginMetadataSnapshot,
    params.agentFacts.input.config,
    params.agentFacts.env,
  );
  const previousInventory = params.inventoryOwner.catalogInventory;
  const previousAuth =
    previousInventory && getPreparedModelFullCatalogAuth(previousInventory.catalog);
  const pluginFingerprint = resolveInstalledManifestRegistryIndexFingerprint(
    params.pluginGeneration.pluginMetadataSnapshot.index,
  );
  const attempt = createCatalogAttemptReporter(
    params.inventoryOwner,
    { key: inventoryKey, pluginFingerprint, credentials: params.agentFacts.credentials },
    params.isCurrent,
  );
  const eligibleProviders = [
    ...new Set(
      [...params.agentFacts.providerIds, ...Object.keys(params.agentFacts.credentials)].map(
        normalizeProvider,
      ),
    ),
  ].toSorted();
  const providerSources = new Map(
    eligibleProviders.map((provider) => [
      provider,
      preparedProviderCatalogSource(
        params.agentFacts,
        params.pluginGeneration,
        provider,
        normalizeProvider,
      ),
    ]),
  );
  const retainedProviders = new Set(
    eligibleProviders.filter(
      (provider) =>
        previousInventory?.pluginFingerprint === pluginFingerprint &&
        previousInventory.providerSources.get(provider) === providerSources.get(provider) &&
        hasSamePreparedModelCatalogAuth(
          previousAuth,
          params.agentFacts,
          (id) => normalizeProvider(id) === provider,
        ),
    ),
  );
  let inventory: PreparedModelCatalogInventory | undefined =
    previousInventory && retainedProviders.size
      ? {
          ...previousInventory,
          catalog: filterPreparedProviderCatalog(previousInventory.catalog, (provider) =>
            retainedProviders.has(normalizeProvider(provider)),
          ),
          nativeSource,
          providerSources: new Map(
            [...previousInventory.providerSources].filter(([provider]) =>
              retainedProviders.has(provider),
            ),
          ),
          providerCredentials: new Map(
            [...previousInventory.providerCredentials].filter(([provider]) =>
              retainedProviders.has(provider),
            ),
          ),
          discoveryOrigins: previousInventory.discoveryOrigins.filter(({ provider }) =>
            retainedProviders.has(normalizeProvider(provider)),
          ),
        }
      : undefined;
  if (inventory) {
    // Native presence markers and empty credentials do not identify an account.
    const identifiedNativeProviders = new Set(
      previousInventory?.nativeSource === nativeSource
        ? Object.entries(params.agentFacts.credentials).flatMap(([provider, credential]) =>
            credential.type === "api_key" && credential.nativeAuth
              ? []
              : [normalizeProvider(provider)],
          )
        : [],
    );
    const retain = (entry: ModelCatalogSnapshot["entries"][number]) =>
      !entry.nativeRuntime || identifiedNativeProviders.has(normalizeProvider(entry.provider));
    inventory.catalog.entries = inventory.catalog.entries.filter(retain);
    inventory.catalog.routeVariants = inventory.catalog.routeVariants.filter(retain);
  }
  const currentAuth = {
    authStore: params.agentFacts.authStore,
    credentials: params.agentFacts.credentials,
    authModes: resolveUsableAgentCredentialModes(params.agentFacts.credentials),
    providerAuthLabels: withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: params.pluginGeneration.pluginRegistry,
      },
      () =>
        prepareModelCatalogAuthLabels({
          config: params.agentFacts.input.config,
          agentDir: params.agentFacts.input.agentDir,
          workspaceDir: params.agentFacts.input.workspaceDir,
          env: params.agentFacts.env,
          store: params.agentFacts.authStore,
          providers: eligibleProviders,
        }),
    ),
  };
  if (inventory && previousAuth) {
    setPreparedModelFullCatalogAuth(inventory.catalog, currentAuth);
  }
  let fullCatalog = inventory ? project(inventory.catalog) : undefined;
  const hasNativeCatalog = params.pluginGeneration.pluginRegistry?.agentHarnesses.some(
    ({ harness }) => typeof harness.loadModelCatalog === "function",
  );
  let nativeCatalogAcquired = !hasNativeCatalog;
  if (fullCatalog) {
    if (hasNativeCatalog) {
      fullCatalog.authoritative = false;
    } else if (eligibleProviders.every((provider) => retainedProviders.has(provider))) {
      markPreparedModelCatalogFull(fullCatalog);
    }
  }
  let pending:
    | {
        providers: readonly string[] | undefined;
        /** Undefined covers unscoped native selection; an empty list schedules none. */
        nativeProviders: readonly string[] | undefined;
        promise: Promise<ModelCatalogSnapshot>;
      }
    | undefined;
  let pendingAuth:
    | {
        key: string;
        promise: Promise<PreparedModelRuntimeAuth>;
      }
    | undefined;
  const assertCurrent = () =>
    assertPreparedModelRuntimeInputCurrent(params.agentFacts.input, params.isCurrent);
  // Construction is lazy: automatic prepared reads do not start a thread. The first explicit
  // request initializes one registry and reuses that exact plugin generation until retirement.
  const worker = createPreparedModelCatalogWorker({
    pluginRegistry: params.pluginGeneration.pluginRegistry,
    agentFacts: params.agentFacts,
    pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
    preferBuiltPluginArtifacts: params.pluginGeneration.preferBuiltPluginArtifacts,
    isCurrent: params.isCurrent,
  });
  const staticCatalog = project(params.catalogFacts.modelCatalog);
  if (!nativeCatalogAcquired) {
    staticCatalog.authoritative = false;
  }
  setPreparedModelFullCatalogAuth(staticCatalog, currentAuth);
  const acquireCatalog = async (
    options: PreparedModelCatalogRefreshOptions = {},
  ): Promise<ModelCatalogSnapshot> => {
    assertCurrent();
    if (
      !options.refresh &&
      !options.changedOnly &&
      fullCatalog &&
      isPreparedModelCatalogFull(fullCatalog)
    ) {
      return fullCatalog;
    }
    const requestedProviders = [
      ...new Set(
        (
          options.providerIds ??
          (options.changedOnly ? Object.keys(params.agentFacts.credentials) : eligibleProviders)
        ).map(normalizeProvider),
      ),
    ];
    const providers = requestedProviders.filter(
      (provider) =>
        !options.changedOnly ||
        inventory?.providerSources.get(provider) !== providerSources.get(provider) ||
        inventory?.providerCredentials.get(provider) !==
          preparedProviderCatalogCredentials(params.agentFacts, provider, normalizeProvider),
    );
    const fullRefresh = !options.changedOnly && !options.providerIds;
    const includeNative = hasNativeCatalog && (!options.changedOnly || !nativeCatalogAcquired);
    const nativeProviders = includeNative
      ? options.providerIds
        ? requestedProviders
        : undefined
      : [];
    if (!providers.length && !includeNative && !fullRefresh) {
      return fullCatalog ?? staticCatalog;
    }
    if (pending) {
      const current = pending;
      const pendingProviders = current.providers;
      const coversProviders =
        pendingProviders === undefined ||
        (!fullRefresh && providers.every((provider) => pendingProviders.includes(provider)));
      const pendingNative = current.nativeProviders;
      const coversNative =
        !includeNative ||
        pendingNative === undefined ||
        (nativeProviders !== undefined &&
          nativeProviders.every((provider) => pendingNative.includes(provider)));
      if (coversNative && coversProviders) {
        return current.promise;
      }
      await current.promise;
      return acquireCatalog(options);
    }
    if (includeNative && !options.providerIds) {
      nativeCatalogAcquired = false;
    }
    attempt.started(providers);
    // Discovery is read-only. Holding the directory build queue here would block an auth
    // replacement and every picker waiting for its static publication.
    const promise = (async () => {
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      const scopes: Array<readonly string[] | undefined> = fullRefresh
        ? [undefined]
        : providers.map((provider) => [provider]);
      for (const providerIds of scopes) {
        await limitFullModelCatalogBuild(async () => {
          assertCurrent();
          const { modelCatalog: workerCatalog, configuredRuntimeModels } =
            await worker.loadCatalog(providerIds);
          assertCurrent();
          const scope = new Set(
            (
              providerIds ?? [
                ...eligibleProviders,
                ...workerCatalog.entries.map((entry) => entry.provider),
                ...(workerCatalog.providerOutcomes ?? []).map((outcome) => outcome.provider),
              ]
            ).map(normalizeProvider),
          );
          const discoveredAuth = getPreparedModelFullCatalogAuth(workerCatalog);
          if (!discoveredAuth) {
            throw new Error("prepared model catalog worker omitted its auth generation");
          }
          const retainedAuth =
            getPreparedModelFullCatalogAuth(fullCatalog ?? staticCatalog) ?? currentAuth;
          const retainOther = <T>(values: Readonly<Record<string, T>>) =>
            Object.fromEntries(
              Object.entries(values).filter(([id]) => !scope.has(normalizeProvider(id))),
            );
          const auth = providerIds
            ? {
                ...discoveredAuth,
                credentials: {
                  ...retainOther(retainedAuth.credentials ?? {}),
                  ...discoveredAuth.credentials,
                },
                authModes: { ...retainOther(retainedAuth.authModes), ...discoveredAuth.authModes },
                providerAuthLabels: new Map([
                  ...[...retainedAuth.providerAuthLabels].filter(
                    ([id]) => !scope.has(normalizeProvider(id)),
                  ),
                  ...discoveredAuth.providerAuthLabels,
                ]),
              }
            : discoveredAuth;
          const publication = prepareModelCatalogPublication(
            providerIds
              ? filterPreparedProviderCatalog(workerCatalog, (provider) =>
                  scope.has(normalizeProvider(provider)),
                )
              : workerCatalog,
            inventory,
            auth,
            normalizeProvider,
          );
          if (providerIds) {
            publication.catalog = mergePreparedProviderCatalog(
              inventory?.catalog,
              publication.catalog,
              scope,
              normalizeProvider,
            );
            publication.discoveryOrigins = [
              ...(inventory?.discoveryOrigins ?? []).filter(
                ({ provider }) => !scope.has(normalizeProvider(provider)),
              ),
              ...publication.discoveryOrigins.filter(({ provider }) =>
                scope.has(normalizeProvider(provider)),
              ),
            ];
          }
          if (inventory) {
            publication.catalog = mergePreparedNativeCatalog(
              inventory.catalog,
              publication.catalog,
            );
          }
          setPreparedModelFullCatalogAuth(publication.catalog, auth);
          currentConfiguredRuntimeModels = configuredRuntimeModels;
          const catalog = project(publication.catalog);
          setPreparedModelFullCatalogAuth(catalog, auth);
          assertCurrent();
          const completedSources = new Map(providerIds ? inventory?.providerSources : undefined);
          const completedCredentials = new Map(
            providerIds ? inventory?.providerCredentials : undefined,
          );
          for (const provider of scope) {
            completedSources.set(
              provider,
              preparedProviderCatalogSource(
                params.agentFacts,
                params.pluginGeneration,
                provider,
                normalizeProvider,
              ),
            );
            completedCredentials.set(
              provider,
              preparedProviderCatalogCredentials(auth, provider, normalizeProvider),
            );
          }
          inventory = {
            ...publication,
            key: inventoryKey,
            pluginFingerprint,
            nativeSource,
            providerSources: completedSources,
            providerCredentials: completedCredentials,
          };
          params.inventoryOwner.catalogInventory = inventory;
          if (!nativeCatalogAcquired) {
            catalog.authoritative = false;
          }
          fullCatalog =
            eligibleProviders.every((provider) => completedSources.has(provider)) &&
            nativeCatalogAcquired
              ? markPreparedModelCatalogFull(catalog)
              : catalog;
          attempt.published(providerIds);
        });
      }
      if (includeNative) {
        const current = fullCatalog ?? staticCatalog;
        const rawInventory = inventory?.catalog ?? { entries: [], routeVariants: [] };
        const sourceAuthority = (inventory?.catalog ?? params.catalogFacts.modelCatalog)
          .authoritative;
        let nativeDiscoveryStarted = false;
        const startupProviders = new Set(params.agentFacts.providerIds.map(normalizeProvider));
        let discoveredProviders: string[] = [];
        const rawCatalog = await augmentPreparedModelCatalogWithAgentHarness({
          input: params.agentFacts.input,
          snapshot: rawInventory,
          preparedSnapshot: current,
          pluginRegistry: params.pluginGeneration.pluginRegistry,
          isCurrent: params.isCurrent,
          includesProvider: options.providerIds
            ? (provider) => requestedProviders.includes(normalizeProvider(provider))
            : undefined,
          onError: (error) => {
            throw error;
          },
          onDiscoveryStarted: (provider) => {
            nativeDiscoveryStarted = true;
            nativeCatalogAcquired = false;
            current.authoritative = false;
            attempt.started([normalizeProvider(provider)]);
          },
          onDiscoveryCompleted: (rows) => {
            discoveredProviders = [
              ...new Set(
                rows
                  .map((entry) => normalizeProvider(entry.provider))
                  .filter((provider) => !startupProviders.has(provider)),
              ),
            ];
          },
        });
        assertCurrent();
        const auth = getPreparedModelFullCatalogAuth(current) ?? currentAuth;
        const nativeAuth =
          nativeDiscoveryStarted && discoveredProviders.length
            ? await worker.loadAuth({ providerIds: discoveredProviders })
            : undefined;
        assertCurrent();
        const retainOther = <T>(values: Readonly<Record<string, T>>) => {
          const refreshedProviders = new Set(
            scopeSyntheticAuthProviderRefs(Object.keys(values), discoveredProviders).map(
              normalizeProvider,
            ),
          );
          return Object.fromEntries(
            Object.entries(values).filter(
              ([provider]) => !refreshedProviders.has(normalizeProvider(provider)),
            ),
          );
        };
        const catalogAuth = {
          ...auth,
          ...(nativeAuth
            ? {
                authStore: nativeAuth.authStore,
                credentials: { ...retainOther(auth.credentials ?? {}), ...nativeAuth.credentials },
                authModes: { ...retainOther(auth.authModes), ...nativeAuth.authModes },
              }
            : {}),
        };
        if (!options.providerIds || nativeDiscoveryStarted) {
          nativeCatalogAcquired = true;
        }
        if (nativeDiscoveryStarted) {
          setPreparedModelFullCatalogAuth(rawCatalog, catalogAuth);
          inventory = {
            catalog: mergePreparedNativeCatalog(rawCatalog, rawInventory),
            key: inventoryKey,
            pluginFingerprint,
            nativeSource,
            providerSources: inventory?.providerSources ?? new Map(),
            providerCredentials: inventory?.providerCredentials ?? new Map(),
            discoveryOrigins: inventory?.discoveryOrigins ?? [],
          };
          setPreparedModelFullCatalogAuth(inventory.catalog, catalogAuth);
          params.inventoryOwner.catalogInventory = inventory;
        }
        const catalog = nativeDiscoveryStarted ? project(rawCatalog) : current;
        catalog.authoritative = nativeCatalogAcquired ? sourceAuthority : false;
        fullCatalog =
          nativeCatalogAcquired &&
          eligibleProviders.every((provider) => inventory?.providerSources.has(provider))
            ? markPreparedModelCatalogFull(attempt.withRefreshStatus(catalog))
            : attempt.withRefreshStatus(catalog);
        if (nativeDiscoveryStarted) {
          attempt.published();
        }
      }
      return fullCatalog ?? staticCatalog;
    })()
      .catch(attempt.failed)
      .finally(() => {
        pending = undefined;
      });
    pending = { providers: fullRefresh ? undefined : providers, nativeProviders, promise };
    return promise;
  };
  return {
    isCurrent: params.isCurrent,
    withRefreshStatus: attempt.withRefreshStatus,
    loadAuth: ({ providerIds, profileIds }) => {
      const cacheKey = [providerIds, profileIds ?? []]
        .map((ids) =>
          [...new Set(ids)].toSorted((left, right) => left.localeCompare(right)).join("\0"),
        )
        .join("\0\0");
      if (pendingAuth?.key === cacheKey) {
        return pendingAuth.promise;
      }
      const promise = (async () => {
        await using _ = {
          [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
        };
        return await worker
          .loadAuth({ providerIds, ...(profileIds?.length ? { profileIds } : {}) })
          .then((refreshed) => {
            const authModes = {
              ...resolveUsableAgentCredentialModes(params.agentFacts.credentials),
            };
            for (const providerId of [
              ...providerIds,
              ...scopeSyntheticAuthProviderRefs(Object.keys(authModes), providerIds),
            ]) {
              delete authModes[normalizeProviderId(providerId)];
            }
            Object.assign(authModes, refreshed.authModes);
            return { authStore: refreshed.authStore, authModes: Object.freeze(authModes) };
          });
      })().finally(() => {
        if (pendingAuth?.promise === promise) {
          pendingAuth = undefined;
        }
      });
      pendingAuth = { key: cacheKey, promise };
      return promise;
    },
    readFullModelCatalog: () => {
      assertCurrent();
      return fullCatalog;
    },
    loadFullModelCatalog: async (options) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          acquireCatalog(options),
          new Promise<ModelCatalogSnapshot>((resolve) => {
            timer = setTimeout(
              () => resolve(fullCatalog ?? staticCatalog),
              MODEL_CATALOG_FOREGROUND_WAIT_MS,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
