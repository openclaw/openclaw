import pLimit from "p-limit";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { createPreparedRuntimeAuthProfileUsageReader } from "./auth-profiles/runtime-snapshots.js";
import {
  augmentPreparedModelCatalogWithAgentHarness,
  isPreparedNativeModelCatalogReady,
} from "./harness/model-catalog.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelFullCatalogAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import {
  prepareInitialModelCatalogAuth,
  replacePreparedModelCatalogAuth,
} from "./prepared-model-runtime.catalog-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { createPreparedModelCatalogProjection } from "./prepared-model-runtime.catalog-projection.js";
import { seedPreparedModelCatalogInventory } from "./prepared-model-runtime.catalog-seed.js";
import {
  preparedProviderCatalogCredentials,
  preparedProviderCatalogSource,
} from "./prepared-model-runtime.catalog-source.js";
import { assertPreparedModelRuntimeInputCurrent } from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  preparedModelInventoryKey,
} from "./prepared-model-runtime.facts.js";
import {
  type PreparedModelRuntimeCatalogAccess,
  filterPreparedProviderCatalog,
  mergePreparedModelCatalogInventory,
  isPreparedModelCatalogFull,
  markPreparedModelCatalogFull,
  mergePreparedNativeCatalog,
  prepareModelCatalogPublication,
  retainPreparedModelCatalogPublication,
} from "./prepared-model-runtime.full-catalog.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  createCatalogAttemptReporter,
  notifyPreparedModelCatalogPublication,
} from "./prepared-model-runtime.publication-events.js";
import { preparedSyntheticAuthProviderScope } from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelCatalogRefreshOptions,
  PreparedNativeModelSelection,
} from "./prepared-model-runtime.types.js";

export const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);
const MODEL_CATALOG_FOREGROUND_WAIT_MS = 5_000;

export function createFullModelCatalogAccess(
  params: PreparedModelRuntimeCatalogAccessParams,
): PreparedModelRuntimeCatalogAccess {
  const readUsage = createPreparedRuntimeAuthProfileUsageReader(
    params.agentFacts.input.agentDir,
    params.agentFacts.input.inheritedAuthDir,
  );
  const setCatalogAuth = (catalog: ModelCatalogSnapshot, auth: PreparedModelCatalogAuth) =>
    setPreparedModelFullCatalogAuth(catalog, auth, (store) =>
      params.isCurrent() ? readUsage(store) : store,
    );
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    params.pluginGeneration.pluginMetadataSnapshot,
    params.agentFacts.input.config,
    params.agentFacts.env,
  );
  const projectInventory = createPreparedModelCatalogProjection({ ...params, normalizeProvider });
  const project = (
    catalog: ModelCatalogSnapshot,
    configuredRuntimeModels = params.catalogFacts.configuredRuntimeModels,
  ) => attempt.withRefreshStatus(projectInventory(catalog, configuredRuntimeModels));
  const inventoryKey = preparedModelInventoryKey(params.agentFacts.input);
  const nativeSource = fingerprintPreparedRuntimeFacts({
    runtimePluginSelections: params.agentFacts.input.runtimePluginSelections,
    config: params.nativeConfigFingerprint,
    configuredModelRefs: params.agentFacts.configuredModelRefs,
  });
  const pluginFingerprint = resolveInstalledManifestRegistryIndexFingerprint(
    params.pluginGeneration.pluginMetadataSnapshot.index,
  );
  const attempt = createCatalogAttemptReporter(
    params.inventoryOwner,
    { key: inventoryKey, pluginFingerprint, credentials: params.agentFacts.credentials },
    params.isCurrent,
    () => {
      if (published.inventory) {
        const providers = new Map(published.inventory.providers);
        // Failed renewal retains rows, but must not retain a successful discovery deadline.
        for (const provider of pending?.providers ?? providers.keys()) {
          const facts = providers.get(provider);
          if (facts) {
            const { expiresAt: _expiresAt, ...retained } = facts;
            providers.set(provider, retained);
          }
        }
        published = {
          ...published,
          inventory: { ...published.inventory, providers },
        };
        params.inventoryOwner.catalogInventory = published.inventory;
      }
    },
  );
  const eligibleProviders = [
    ...new Set(
      [...params.agentFacts.providerIds, ...Object.keys(params.agentFacts.credentials)].map(
        normalizeProvider,
      ),
    ),
  ].toSorted();
  const providerSource = (provider: string) =>
    preparedProviderCatalogSource(
      params.agentFacts,
      params.pluginGeneration,
      provider,
      normalizeProvider,
    );
  const providerSources = new Map(
    eligibleProviders.map((provider) => [provider, providerSource(provider)]),
  );
  const retainedInventory = seedPreparedModelCatalogInventory({
    previousInventory: params.inventoryOwner.catalogInventory,
    agentFacts: params.agentFacts,
    pluginFingerprint,
    nativeSource,
    eligibleProviders,
    providerSources,
    normalizeProvider,
  });
  const currentAuth = prepareInitialModelCatalogAuth(params, eligibleProviders);
  if (retainedInventory) {
    setCatalogAuth(retainedInventory.catalog, currentAuth);
  }
  const hasNativeCatalog = params.pluginGeneration.pluginRegistry?.agentHarnesses.some(
    ({ harness }) => typeof harness.loadModelCatalog === "function",
  );
  type CatalogCandidate = {
    inventory: PreparedModelCatalogInventory | undefined;
    configuredRuntimeModels: typeof params.catalogFacts.configuredRuntimeModels;
    nativeCatalogAcquired: boolean;
  };
  type Publication = CatalogCandidate & { catalog: ModelCatalogSnapshot | undefined };
  let published: Publication = {
    catalog: undefined,
    inventory: retainedInventory,
    configuredRuntimeModels: params.catalogFacts.configuredRuntimeModels,
    nativeCatalogAcquired: !hasNativeCatalog,
  };
  let pending:
    | {
        providers: readonly string[] | undefined;
        nativeProviders: readonly string[] | undefined;
        promise: Promise<ModelCatalogSnapshot>;
      }
    | undefined;
  let nativePending: Promise<ModelCatalogSnapshot> | undefined;
  const assertCurrent = () =>
    assertPreparedModelRuntimeInputCurrent(params.agentFacts.input, params.isCurrent);
  const worker = createPreparedModelCatalogWorker({
    pluginRegistry: params.pluginGeneration.pluginRegistry,
    agentFacts: params.agentFacts,
    pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
    preferBuiltPluginArtifacts: params.pluginGeneration.preferBuiltPluginArtifacts,
    isCurrent: params.isCurrent,
    retirementSignal: params.retirementSignal,
  });
  const staticCatalog = project(params.catalogFacts.modelCatalog);
  if (hasNativeCatalog) {
    staticCatalog.authoritative = false;
  }
  setCatalogAuth(staticCatalog, currentAuth);
  const preparePublication = (
    nextInventory: PreparedModelCatalogInventory,
    configuredRuntimeModels: Publication["configuredRuntimeModels"],
    acquiredNative: boolean,
  ): Publication => {
    const catalog = project(nextInventory.catalog, configuredRuntimeModels);
    setCatalogAuth(catalog, getPreparedModelFullCatalogAuth(nextInventory.catalog) ?? currentAuth);
    catalog.authoritative =
      acquiredNative && !catalog.refreshFailed ? catalog.authoritative : false;
    if (
      acquiredNative &&
      eligibleProviders.every((provider) => nextInventory.providers.has(provider))
    ) {
      markPreparedModelCatalogFull(catalog);
    }
    return {
      catalog,
      inventory: nextInventory,
      configuredRuntimeModels,
      nativeCatalogAcquired: acquiredNative,
    };
  };
  if (retainedInventory) {
    published = preparePublication(
      retainedInventory,
      published.configuredRuntimeModels,
      published.nativeCatalogAcquired,
    );
  }
  const publishCatalog = (candidate: CatalogCandidate, source: "provider" | "native") => {
    assertCurrent();
    const previous = published;
    let next: Publication = { ...candidate, catalog: previous.catalog };
    if (candidate.inventory) {
      const providers =
        source === "provider" ? candidate.inventory : (previous.inventory ?? candidate.inventory);
      const native =
        source === "native" ? candidate.inventory.catalog : previous.inventory?.catalog;
      const apiCatalog =
        source === "native" && !previous.inventory
          ? params.catalogFacts.modelCatalog
          : providers.catalog;
      const inventory = {
        ...providers,
        catalog: native ? mergePreparedNativeCatalog(native, apiCatalog) : apiCatalog,
      };
      setCatalogAuth(
        inventory.catalog,
        getPreparedModelFullCatalogAuth(candidate.inventory.catalog) ?? currentAuth,
      );
      // Commit the current counterpart synchronously. A worker's promise settlement leaves a
      // microtask gap in which native selection may publish, even after discovery has finished.
      const baseline = source === "native" ? (previous.catalog ?? staticCatalog) : undefined;
      next = preparePublication(
        inventory,
        source === "native" ? previous.configuredRuntimeModels : candidate.configuredRuntimeModels,
        source === "provider" ? previous.nativeCatalogAcquired : candidate.nativeCatalogAcquired,
      );
      assertCurrent();
      if (baseline && next.catalog) {
        // Native completion changes readiness, not the provider facts already visible to readers.
        baseline.authoritative = next.catalog.authoritative;
        if (isPreparedModelCatalogFull(next.catalog)) {
          markPreparedModelCatalogFull(baseline);
        }
        next.catalog = retainPreparedModelCatalogPublication(next.catalog, baseline);
      }
    }
    published = {
      ...next,
      catalog: retainPreparedModelCatalogPublication(next.catalog, previous.catalog),
    };
    params.inventoryOwner.catalogInventory = published.inventory;
    return { previous, current: published, staticCatalog };
  };
  const acquireProviderCatalog = async (
    providerIds: readonly string[] | undefined,
    providers: readonly string[],
  ): Promise<CatalogCandidate> =>
    limitFullModelCatalogBuild(async () => {
      assertCurrent();
      const {
        modelCatalog: workerCatalog,
        configuredRuntimeModels,
        runtimeModels,
        providerExpiries,
        hookRows,
      } = await worker.loadCatalog(
        providerIds,
        (providerIds ?? providers).some((provider) => published.inventory?.providers.has(provider))
          ? (error) => attempt.failed(error, providerIds ?? providers, "provider")
          : undefined,
      );
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
      const retained = published.inventory;
      const retainedAuth =
        getPreparedModelFullCatalogAuth(published.catalog ?? staticCatalog) ?? currentAuth;
      const auth = providerIds
        ? replacePreparedModelCatalogAuth(retainedAuth, discoveredAuth, (provider) =>
            scope.has(normalizeProvider(provider)),
          )
        : discoveredAuth;
      const { legacyRows, ...publication } = prepareModelCatalogPublication(
        providerIds
          ? filterPreparedProviderCatalog(workerCatalog, (provider) =>
              scope.has(normalizeProvider(provider)),
            )
          : workerCatalog,
        new Map([...runtimeModels].filter(([provider]) => scope.has(normalizeProvider(provider)))),
        retained,
        auth,
        normalizeProvider,
        hookRows,
      );
      const completedProviders = new Map(
        [...scope].map((provider) => {
          const expiresAt = providerExpiries.get(provider);
          const failed = workerCatalog.providerOutcomes?.some(
            (outcome) =>
              normalizeProvider(outcome.provider) === provider && outcome.status !== "ready",
          );
          return [
            provider,
            {
              source: providerSource(provider),
              credentials: preparedProviderCatalogCredentials(auth, provider, normalizeProvider),
              ...(!failed && expiresAt !== undefined ? { expiresAt } : {}),
              ...(legacyRows.get(provider)?.size ? { legacyRows: legacyRows.get(provider) } : {}),
            },
          ] as const;
        }),
      );
      const acquired = {
        ...publication,
        key: inventoryKey,
        pluginFingerprint,
        nativeSource,
        providers: completedProviders,
      };
      const inventory = providerIds
        ? mergePreparedModelCatalogInventory(retained, acquired, scope, normalizeProvider)
        : acquired;
      setCatalogAuth(inventory.catalog, auth);
      return {
        inventory,
        configuredRuntimeModels,
        nativeCatalogAcquired: published.nativeCatalogAcquired,
      };
    });

  const acquireNativeCatalog = (
    providerIds?: readonly string[],
    selection?: PreparedNativeModelSelection,
  ): Promise<ModelCatalogSnapshot> => {
    const selectionReady = () => {
      assertCurrent();
      const ready =
        selection &&
        isPreparedNativeModelCatalogReady({
          input: params.agentFacts.input,
          pluginGeneration: params.pluginGeneration,
          snapshot: published.catalog ?? staticCatalog,
          selection,
        });
      // Readiness invokes plugin code, which can retire this owner before the fast return.
      assertCurrent();
      return ready;
    };
    if (selectionReady()) {
      return Promise.resolve(published.catalog ?? staticCatalog);
    }
    const previousNative = nativePending;
    let failedProviders: readonly string[] | undefined;
    const promise = (async () => {
      await previousNative?.catch(() => undefined);
      if (selectionReady()) {
        return published.catalog ?? staticCatalog;
      }
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      let discoveredProviders: string[] = [];
      let completed = false;
      const failures: Array<{ error: unknown; providers?: readonly string[] }> = [];
      const startupProviders = new Set(params.agentFacts.providerIds.map(normalizeProvider));
      attempt.setPending([], "native");
      const rawCatalog = await augmentPreparedModelCatalogWithAgentHarness({
        input: params.agentFacts.input,
        nativeSelection: selection,
        snapshot: published.inventory?.catalog ?? params.catalogFacts.modelCatalog,
        normalizeProvider,
        preparedSnapshot: published.catalog ?? staticCatalog,
        pluginRegistry: params.pluginGeneration.pluginRegistry,
        isCurrent: params.isCurrent,
        includesProvider: providerIds
          ? (provider) => providerIds.includes(normalizeProvider(provider))
          : undefined,
        onError: (error, failedProviderIds) => {
          failures.push({ error, providers: failedProviderIds?.map(normalizeProvider) });
        },
        onDiscoveryStarted: (provider) =>
          attempt.setPending([normalizeProvider(provider)], "native"),
        onDiscoveryCompleted: (rows) => {
          completed = true;
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
      if (!completed && failures.length) {
        failedProviders = failures.flatMap((failure) => failure.providers ?? []);
        throw failures[0]!.error;
      }
      // Selected native membership is a foreground harness fact, not a provider-auth refresh.
      // Full inventory acquisition alone discovers additional paired provider credentials.
      const nativeAuth =
        !selection && completed && discoveredProviders.length
          ? await worker.loadAuth({ providerIds: discoveredProviders })
          : undefined;
      assertCurrent();
      // Provider renewal may finish during native discovery. Commit native observations onto
      // that latest provider publication; a captured pre-await inventory must never replace it.
      const latest = published;
      const latestInventory = latest.inventory;
      const auth =
        getPreparedModelFullCatalogAuth(latest.inventory?.catalog ?? staticCatalog) ?? currentAuth;
      const nativeScope = preparedSyntheticAuthProviderScope(discoveredProviders);
      const catalogAuth = nativeAuth
        ? replacePreparedModelCatalogAuth(auth, nativeAuth, (provider) =>
            nativeScope.has(normalizeProvider(provider)),
          )
        : auth;
      const acquiredNative =
        latest.nativeCatalogAcquired || (!selection && (!providerIds || completed));
      const nextInventory = completed
        ? {
            catalog: {
              ...rawCatalog,
              authoritative: (latestInventory?.catalog ?? params.catalogFacts.modelCatalog)
                .authoritative,
            },
            runtimeModels: latestInventory?.runtimeModels ?? new Map(),
            key: inventoryKey,
            pluginFingerprint,
            nativeSource,
            providers: latestInventory?.providers ?? new Map(),
            discoveryOrigins: latestInventory?.discoveryOrigins ?? [],
          }
        : latestInventory;
      if (nextInventory) {
        setCatalogAuth(nextInventory.catalog, catalogAuth);
      }
      if (completed) {
        attempt.published(providerIds, "native");
      } else {
        attempt.setPending(undefined, "native");
      }
      for (const failure of failures) {
        attempt.failed(failure.error, failure.providers, "native");
      }
      notifyPreparedModelCatalogPublication(
        publishCatalog(
          { ...latest, inventory: nextInventory, nativeCatalogAcquired: acquiredNative },
          "native",
        ),
      );
      return published.catalog ?? staticCatalog;
    })()
      .catch((error: unknown) => {
        attempt.failed(error, failedProviders ?? providerIds, "native");
        if (published.catalog) {
          attempt.withRefreshStatus(published.catalog);
        }
        throw error;
      })
      .finally(() => {
        if (nativePending === promise) {
          nativePending = undefined;
        }
      });
    nativePending = promise;
    return promise;
  };

  const refreshExpiredModelCatalog = () => {
    assertCurrent();
    if (pending || !published.inventory) {
      return;
    }
    const now = Date.now();
    const providers = [...published.inventory.providers]
      .filter(([, { expiresAt }]) => expiresAt !== undefined && expiresAt <= now)
      .map(([provider]) => provider);
    if (providers.length) {
      void acquireCatalog({ providerIds: providers, refresh: true }, false).catch(() => undefined);
    }
  };
  const acquireCatalog = async (
    options: PreparedModelCatalogRefreshOptions = {},
    acquireNative = true,
  ): Promise<ModelCatalogSnapshot> => {
    assertCurrent();
    if (
      !options.refresh &&
      !options.changedOnly &&
      published.catalog &&
      isPreparedModelCatalogFull(published.catalog)
    ) {
      refreshExpiredModelCatalog();
      return published.catalog;
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
        published.inventory?.providers.get(provider)?.source !== providerSources.get(provider) ||
        published.inventory?.providers.get(provider)?.credentials !==
          preparedProviderCatalogCredentials(params.agentFacts, provider, normalizeProvider),
    );
    const fullRefresh = !options.changedOnly && !options.providerIds;
    const includeNative =
      acquireNative &&
      hasNativeCatalog &&
      (!options.changedOnly || !published.nativeCatalogAcquired);
    const nativeProviders = includeNative
      ? options.providerIds
        ? requestedProviders
        : undefined
      : [];
    if (!providers.length && !includeNative && !fullRefresh) {
      return published.catalog ?? staticCatalog;
    }
    if (pending) {
      const current = pending;
      const coversProviders =
        current.providers === undefined ||
        (!fullRefresh && providers.every((provider) => current.providers!.includes(provider)));
      const coversNative =
        !includeNative ||
        current.nativeProviders === undefined ||
        (nativeProviders !== undefined &&
          nativeProviders.every((provider) => current.nativeProviders!.includes(provider)));
      if (coversProviders && coversNative) {
        return current.promise;
      }
      await current.promise.catch(() => undefined);
      return acquireCatalog(options, acquireNative);
    }
    attempt.setPending(fullRefresh || providers.length ? providers : undefined);
    const promise = (async () => {
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      if (fullRefresh || providers.length) {
        const candidate = await acquireProviderCatalog(
          fullRefresh ? undefined : providers,
          providers,
        ).catch((error: unknown) => {
          attempt.failed(error, providers, "provider");
          throw error;
        });
        // Provider facts belong to their completed acquisition; optional native failure cannot
        // discard them. Native discovery starts from this accepted publication.
        attempt.published(fullRefresh ? undefined : providers, "provider", () =>
          publishCatalog(candidate, "provider"),
        );
      }
      if (includeNative) {
        return await acquireNativeCatalog(options.providerIds ? requestedProviders : undefined);
      }
      return published.catalog ?? staticCatalog;
    })().finally(() => {
      pending = undefined;
    });
    pending = { providers: fullRefresh ? undefined : providers, nativeProviders, promise };
    return promise;
  };
  return {
    initialAuth: currentAuth,
    isCurrent: params.isCurrent,
    withRefreshStatus: attempt.withRefreshStatus,
    loadAuth: async ({ providerIds, profileIds }) => {
      assertCurrent();
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      const refreshed = await worker.loadAuth({
        providerIds,
        ...(profileIds?.length ? { profileIds } : {}),
      });
      assertCurrent();
      const previous =
        getPreparedModelFullCatalogAuth(published.catalog ?? staticCatalog) ?? currentAuth;
      const scope = preparedSyntheticAuthProviderScope(providerIds.map(normalizeProvider));
      const { authStore, authModes } = replacePreparedModelCatalogAuth(
        previous,
        refreshed,
        (provider) => scope.has(normalizeProvider(provider)),
      );
      return { authStore, authModes: Object.freeze(authModes) };
    },
    readFullModelCatalog: () => {
      assertCurrent();
      return published.catalog;
    },
    refreshExpiredModelCatalog,
    readPublishedModels: () => {
      assertCurrent();
      return published.inventory?.runtimeModels;
    },
    loadNativeModelCatalog: async (selection) =>
      await acquireNativeCatalog([normalizeProvider(selection.provider)], selection),
    loadFullModelCatalog: async (options) => {
      // Standalone commands cannot publish background discovery after their process exits.
      if (options?.refresh && params.inventoryOwner.provenance === "standalone") {
        return await acquireCatalog(options);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          acquireCatalog(options),
          new Promise<ModelCatalogSnapshot>((resolve) => {
            timer = setTimeout(
              () => resolve(published.catalog ?? staticCatalog),
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
