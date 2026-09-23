import pLimit from "p-limit";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { createPreparedRuntimeAuthProfileUsageReader } from "./auth-profiles/runtime-snapshots.js";
import {
  augmentPreparedModelCatalogWithAgentHarness,
  isPreparedNativeModelCatalogReady,
} from "./harness/model-catalog.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { createPreparedModelCatalogAuthLoader } from "./prepared-model-runtime.catalog-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { createPreparedModelCatalogProjection } from "./prepared-model-runtime.catalog-projection.js";
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
  expirePreparedModelCatalogProviders,
  listExpiredPreparedModelCatalogProviders,
  filterPreparedProviderCatalog,
  mergePreparedProviderCatalog,
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
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
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
  let currentConfiguredRuntimeModels = params.catalogFacts.configuredRuntimeModels;
  let publishedRuntimeModels: PreparedModelCatalogInventory["runtimeModels"] | undefined;
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    params.pluginGeneration.pluginMetadataSnapshot,
    params.agentFacts.input.config,
    params.agentFacts.env,
  );
  const projectInventory = createPreparedModelCatalogProjection({ ...params, normalizeProvider });
  const project = (
    catalog: ModelCatalogSnapshot,
    runtimeModels:
      | PreparedModelCatalogInventory["runtimeModels"]
      | undefined = inventory?.runtimeModels,
  ) => {
    const projected = projectInventory(catalog, currentConfiguredRuntimeModels);
    publishedRuntimeModels = runtimeModels;
    return attempt.withRefreshStatus(projected);
  };
  const inventoryKey = preparedModelInventoryKey(params.agentFacts.input);
  const nativeSource = fingerprintPreparedRuntimeFacts({
    runtimePluginSelections: params.agentFacts.input.runtimePluginSelections,
    config: params.nativeConfigFingerprint,
    configuredModelRefs: params.agentFacts.configuredModelRefs,
  });
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
        previousInventory.providers.get(provider)?.source === providerSources.get(provider) &&
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
          runtimeModels: new Map(
            [...previousInventory.runtimeModels].filter(([provider]) =>
              retainedProviders.has(normalizeProvider(provider)),
            ),
          ),
          nativeSource,
          providers: new Map(
            [...previousInventory.providers].filter(([provider]) =>
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
    if (inventory.catalog.nativeProviderOutcomes) {
      inventory.catalog.nativeProviderOutcomes = Object.fromEntries(
        Object.entries(inventory.catalog.nativeProviderOutcomes).map(([runtime, outcomes]) => [
          runtime,
          outcomes.filter(({ provider }) =>
            identifiedNativeProviders.has(normalizeProvider(provider)),
          ),
        ]),
      );
    }
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
    setCatalogAuth(inventory.catalog, currentAuth);
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
        nativeRuntime: string | undefined;
        promise: Promise<ModelCatalogSnapshot>;
      }
    | undefined;
  const assertCurrent = () =>
    assertPreparedModelRuntimeInputCurrent(params.agentFacts.input, params.isCurrent);
  // Acquisition reuses this exact plugin generation until retirement.
  const worker = createPreparedModelCatalogWorker({
    pluginRegistry: params.pluginGeneration.pluginRegistry,
    agentFacts: params.agentFacts,
    pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
    preferBuiltPluginArtifacts: params.pluginGeneration.preferBuiltPluginArtifacts,
    isCurrent: params.isCurrent,
    retirementSignal: params.retirementSignal,
  });
  const staticCatalog = project(params.catalogFacts.modelCatalog);
  if (!nativeCatalogAcquired) {
    staticCatalog.authoritative = false;
  }
  setCatalogAuth(staticCatalog, currentAuth);
  const capturePublication = () => ({
    catalog: fullCatalog,
    runtimeModels: publishedRuntimeModels,
    configuredRuntimeModels: currentConfiguredRuntimeModels,
    inventory,
    nativeCatalogAcquired,
  });
  let published = capturePublication();
  const publishCatalog = () => {
    assertCurrent();
    const previous = published;
    fullCatalog = retainPreparedModelCatalogPublication(fullCatalog, published.catalog);
    published = capturePublication();
    params.inventoryOwner.catalogInventory = inventory;
    return { previous, current: published, staticCatalog };
  };
  const refreshExpiredCatalog = () => {
    if (pending || !inventory) {
      return;
    }
    const providerIds = listExpiredPreparedModelCatalogProviders(inventory, Date.now());
    if (!providerIds.length) {
      return;
    }
    queueMicrotask(() => {
      void acquireCatalog({ providerIds, refresh: true }, false).catch(() => undefined);
    });
  };
  const acquireCatalog = async (
    options: PreparedModelCatalogRefreshOptions = {},
    acquireNative = true,
    nativeSelection?: PreparedNativeModelSelection,
  ): Promise<ModelCatalogSnapshot> => {
    assertCurrent();
    if (
      !options.refresh &&
      !options.changedOnly &&
      published.catalog &&
      isPreparedModelCatalogFull(published.catalog)
    ) {
      refreshExpiredCatalog();
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
    const providers = (nativeSelection ? [] : requestedProviders).filter(
      (provider) =>
        !options.changedOnly ||
        inventory?.providers.get(provider)?.source !== providerSources.get(provider) ||
        inventory?.providers.get(provider)?.credentials !==
          preparedProviderCatalogCredentials(params.agentFacts, provider, normalizeProvider),
    );
    const fullRefresh = !options.changedOnly && !options.providerIds;
    const includeNative =
      acquireNative && hasNativeCatalog && (!options.changedOnly || !nativeCatalogAcquired);
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
      const pendingProviders = current.providers;
      const coversProviders =
        pendingProviders === undefined ||
        (!fullRefresh && providers.every((provider) => pendingProviders.includes(provider)));
      const pendingNative = current.nativeProviders;
      const coversNative =
        !includeNative ||
        ((current.nativeRuntime === undefined ||
          current.nativeRuntime === nativeSelection?.runtime) &&
          (pendingNative === undefined ||
            (nativeProviders !== undefined &&
              nativeProviders.every((provider) => pendingNative.includes(provider)))));
      if (coversNative && coversProviders) {
        return current.promise;
      }
      // Uncovered requests wait for settlement; the prior scope owns its failure.
      await current.promise.catch(() => undefined);
      return acquireCatalog(options, acquireNative, nativeSelection);
    }
    // Provider rows are only a candidate until native discovery and its paired auth settle.
    const previous = fullRefresh && includeNative ? published : undefined;
    if (includeNative && !options.providerIds) {
      nativeCatalogAcquired = false;
    }
    attempt.started(providers);
    // Discovery is read-only. Holding the directory build queue here would block an auth
    // replacement and every picker waiting for its static publication.
    let failedNativeProviders: readonly string[] | undefined;
    const fail = attempt.createFailureHandler(providers, (providerIds) => {
      if (published.inventory) {
        inventory = expirePreparedModelCatalogProviders(published.inventory, providerIds);
        params.inventoryOwner.catalogInventory = inventory;
        published.inventory = inventory;
      }
    });
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
          const {
            modelCatalog: workerCatalog,
            configuredRuntimeModels,
            runtimeModels,
            providerExpiries,
          } = await worker.loadCatalog(
            providerIds,
            (providerIds ?? providers).some((provider) =>
              published.inventory?.providers.has(provider),
            )
              ? (error) => fail(error, providerIds, "provider")
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
            new Map(
              [...runtimeModels].filter(([provider]) => scope.has(normalizeProvider(provider))),
            ),
            inventory,
            auth,
            normalizeProvider,
          );
          if (providerIds) {
            publication.runtimeModels = new Map([
              ...[...(inventory?.runtimeModels ?? [])].filter(
                ([provider]) => !scope.has(normalizeProvider(provider)),
              ),
              ...publication.runtimeModels,
            ]);
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
          setCatalogAuth(publication.catalog, auth);
          currentConfiguredRuntimeModels = configuredRuntimeModels;
          const catalog = project(publication.catalog, publication.runtimeModels);
          setCatalogAuth(catalog, auth);
          assertCurrent();
          const completedProviders = new Map(providerIds ? inventory?.providers : undefined);
          for (const provider of scope) {
            const expiresAt = providerExpiries.get(provider);
            const failed = workerCatalog.providerOutcomes?.some(
              (outcome) =>
                normalizeProvider(outcome.provider) === provider && outcome.status !== "ready",
            );
            completedProviders.set(provider, {
              source: preparedProviderCatalogSource(
                params.agentFacts,
                params.pluginGeneration,
                provider,
                normalizeProvider,
              ),
              credentials: preparedProviderCatalogCredentials(auth, provider, normalizeProvider),
              ...(!failed && expiresAt !== undefined ? { expiresAt } : {}),
            });
          }
          inventory = {
            ...publication,
            key: inventoryKey,
            pluginFingerprint,
            nativeSource,
            providers: completedProviders,
          };
          if (!nativeCatalogAcquired) {
            catalog.authoritative = false;
          }
          fullCatalog =
            eligibleProviders.every((provider) => completedProviders.has(provider)) &&
            nativeCatalogAcquired
              ? markPreparedModelCatalogFull(catalog)
              : catalog;
          if (!previous) {
            attempt.published(providerIds, "provider", publishCatalog());
          }
        }).catch((error: unknown) => {
          fail(error, providerIds, "provider");
          throw error;
        });
      }
      if (includeNative) {
        const current = fullCatalog ?? staticCatalog;
        const rawInventory = inventory?.catalog ?? { entries: [], routeVariants: [] };
        const sourceAuthority = (inventory?.catalog ?? params.catalogFacts.modelCatalog)
          .authoritative;
        let nativeDiscoveryCompleted = false;
        const startupProviders = new Set(params.agentFacts.providerIds.map(normalizeProvider));
        let discoveredProviders: string[] = [];
        const nativeFailures: Array<{ error: unknown; providers?: readonly string[] }> = [];
        const rawCatalog = await augmentPreparedModelCatalogWithAgentHarness({
          input: params.agentFacts.input,
          nativeSelection,
          snapshot: rawInventory,
          normalizeProvider,
          preparedSnapshot: current,
          pluginRegistry: params.pluginGeneration.pluginRegistry,
          isCurrent: params.isCurrent,
          includesProvider: options.providerIds
            ? (provider) => requestedProviders.includes(normalizeProvider(provider))
            : undefined,
          onError: (error, failedProviderIds) => {
            nativeFailures.push({ error, providers: failedProviderIds?.map(normalizeProvider) });
          },
          onDiscoveryStarted: (provider) => {
            if (!nativeSelection) {
              nativeCatalogAcquired = false;
            }
            current.authoritative = false;
            attempt.started([normalizeProvider(provider)], "native");
          },
          onDiscoveryCompleted: (rows) => {
            nativeDiscoveryCompleted = true;
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
        const firstNativeFailure = nativeFailures[0];
        if (firstNativeFailure && !nativeDiscoveryCompleted) {
          failedNativeProviders = nativeFailures.flatMap(
            ({ providers: failedProviderIds }) => failedProviderIds ?? [],
          );
          throw firstNativeFailure.error;
        }
        const auth = getPreparedModelFullCatalogAuth(current) ?? currentAuth;
        const nativeAuth =
          nativeDiscoveryCompleted && discoveredProviders.length
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
        nativeCatalogAcquired ||=
          !nativeSelection && (!options.providerIds || nativeDiscoveryCompleted);
        if (nativeDiscoveryCompleted) {
          setCatalogAuth(rawCatalog, catalogAuth);
          inventory = {
            catalog: mergePreparedNativeCatalog(rawCatalog, rawInventory),
            runtimeModels: inventory?.runtimeModels ?? new Map(),
            key: inventoryKey,
            pluginFingerprint,
            nativeSource,
            providers: inventory?.providers ?? new Map(),
            discoveryOrigins: inventory?.discoveryOrigins ?? [],
          };
          setCatalogAuth(inventory.catalog, catalogAuth);
        }
        const catalog =
          nativeDiscoveryCompleted && rawCatalog !== rawInventory ? project(rawCatalog) : current;
        fullCatalog =
          nativeCatalogAcquired &&
          eligibleProviders.every((provider) => inventory?.providers.has(provider))
            ? markPreparedModelCatalogFull(attempt.withRefreshStatus(catalog))
            : attempt.withRefreshStatus(catalog);
        if (previous) {
          attempt.published(undefined);
        }
        if (nativeDiscoveryCompleted) {
          attempt.published(options.providerIds ? requestedProviders : undefined, "native");
        }
        for (const { error, providers: failedProviderIds } of nativeFailures) {
          attempt.failed(error, failedProviderIds, "native");
        }
        catalog.authoritative =
          nativeCatalogAcquired && !catalog.refreshFailed ? sourceAuthority : false;
        notifyPreparedModelCatalogPublication(publishCatalog());
      }
      return fullCatalog ?? staticCatalog;
    })()
      .catch((error: unknown) => {
        if (previous) {
          inventory = previous.inventory;
          fullCatalog = previous.catalog;
          publishedRuntimeModels = previous.runtimeModels;
          currentConfiguredRuntimeModels = previous.configuredRuntimeModels;
          nativeCatalogAcquired = previous.nativeCatalogAcquired;
        }
        fail(error, failedNativeProviders, failedNativeProviders ? "native" : undefined);
        if (published.catalog) {
          attempt.withRefreshStatus(published.catalog);
        }
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    pending = {
      providers: fullRefresh ? undefined : providers,
      nativeProviders,
      nativeRuntime: nativeSelection?.runtime,
      promise,
    };
    return promise;
  };
  return {
    isCurrent: params.isCurrent,
    withRefreshStatus: attempt.withRefreshStatus,
    loadAuth: createPreparedModelCatalogAuthLoader({ ...params, assertCurrent, worker }),
    readFullModelCatalog: () => {
      assertCurrent();
      refreshExpiredCatalog();
      return published.catalog;
    },
    readPublishedModelCatalog: () => {
      assertCurrent();
      return published.catalog;
    },
    readPublishedModels: () => {
      assertCurrent();
      return published.runtimeModels;
    },
    loadNativeModelCatalog: async (selection) => {
      assertCurrent();
      const catalog = published.catalog ?? staticCatalog;
      if (
        isPreparedNativeModelCatalogReady({
          input: params.agentFacts.input,
          pluginGeneration: params.pluginGeneration,
          snapshot: catalog,
          selection,
        })
      ) {
        assertCurrent();
        return catalog;
      }
      return await acquireCatalog(
        { providerIds: [selection.provider], refresh: true },
        true,
        selection,
      );
    },
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
