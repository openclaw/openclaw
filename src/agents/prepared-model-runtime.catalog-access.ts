import pLimit from "p-limit";
import { withRemoteModelCatalogSnapshot } from "../model-catalog/remote-overlay.js";
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
import { getPreparedModelRuntimeBorrowedSnapshot } from "./prepared-model-runtime-generation-scope.js";
import { readCapturedPreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import {
  createNativeLoginRecheck,
  createPreparedAccountCatalogAccess,
  loadScopedModelCatalogAuth,
  prepareInitialModelCatalogAuth,
  replacePreparedModelCatalogAuth,
} from "./prepared-model-runtime.catalog-auth.js";
import type {
  PreparedModelCatalogCandidate,
  PreparedModelRuntimeCatalogAccess,
  PreparedModelRuntimeCatalogAccessParams,
} from "./prepared-model-runtime.catalog-contract.js";
import { createPreparedModelCatalogProjection } from "./prepared-model-runtime.catalog-projection.js";
import { createPreparedModelCatalogGenerationRecoveryHandler } from "./prepared-model-runtime.catalog-recovery-handler.js";
import {
  preparedProviderCatalogCredentials,
  prepareRetainedProviderCatalog,
} from "./prepared-model-runtime.catalog-source.js";
import * as retry from "./prepared-model-runtime.discovery-retry.js";
import { assertPreparedModelRuntimeInputCurrent } from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  preparedModelInventoryKey,
} from "./prepared-model-runtime.facts.js";
import {
  filterPreparedProviderCatalog,
  mergePreparedModelCatalogInventory,
  isPreparedModelCatalogFull,
  markPreparedModelCatalogFull,
  mergePreparedNativeCatalog,
  prepareModelCatalogPublication,
  retainPreparedModelCatalogPublication,
} from "./prepared-model-runtime.full-catalog.js";
import { capturePreparedModelRuntimeLifetime } from "./prepared-model-runtime.lifecycle.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  createCatalogAttemptReporter,
  notifyPreparedModelCatalogPublication,
  notifyPreparedModelRuntimePublication,
} from "./prepared-model-runtime.publication-events.js";
import { preparedSyntheticAuthProviderScope } from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelCatalogRefreshOptions,
  PreparedNativeModelSelection,
} from "./prepared-model-runtime.types.js";

export const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);

export async function createFullModelCatalogAccess(
  params: PreparedModelRuntimeCatalogAccessParams,
  assertBuildCurrent: () => void,
): Promise<PreparedModelRuntimeCatalogAccess> {
  assertBuildCurrent();
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    params.pluginGeneration.pluginMetadataSnapshot,
    params.agentFacts.input.config,
    params.agentFacts.env,
  );
  const eligibleProviders = [
    ...new Set(
      [...params.agentFacts.providerIds, ...Object.keys(params.agentFacts.credentials)].map(
        normalizeProvider,
      ),
    ),
  ].toSorted();
  const currentAuth = await prepareInitialModelCatalogAuth(
    params,
    eligibleProviders,
    assertBuildCurrent,
  );
  assertBuildCurrent();
  const accountCatalog = createPreparedAccountCatalogAccess(
    params.isCurrent,
    params.retirementSignal,
    params.agentFacts.input.config,
    () => {
      if (params.catalogOwner && params.isPublished?.() !== false) {
        notifyPreparedModelRuntimePublication({
          phase: "catalog-observation",
          modelFactsChanged: false,
          agentId: params.catalogOwner.agentId,
        });
      }
    },
  );
  const readUsage = createPreparedRuntimeAuthProfileUsageReader(
    params.agentFacts.input.agentDir,
    params.agentFacts.input.inheritedAuthDir,
  );
  const setCatalogAuth = (catalog: ModelCatalogSnapshot, auth: PreparedModelCatalogAuth) =>
    setPreparedModelFullCatalogAuth(catalog, auth, (store) =>
      params.isCurrent() ? readUsage(store) : store,
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
        published = {
          ...published,
          inventory: retry.recordFailedDiscovery(published.inventory, pending?.providers),
        };
        params.inventoryOwner.catalogInventory = published.inventory;
      }
    },
    params.isPublished,
  );
  const recoverCatalogGeneration = createPreparedModelCatalogGenerationRecoveryHandler(params);
  const { providerSource, retainedInventory, listChangedProviders } =
    prepareRetainedProviderCatalog(
      params,
      normalizeProvider,
      eligibleProviders,
      pluginFingerprint,
      nativeSource,
    );
  if (retainedInventory) {
    setCatalogAuth(retainedInventory.catalog, currentAuth);
  }
  const hasNativeCatalog = params.pluginGeneration.pluginRegistry?.agentHarnesses.some(
    ({ harness }) => typeof harness.loadModelCatalog === "function",
  );
  type Publication = PreparedModelCatalogCandidate & { catalog: ModelCatalogSnapshot | undefined };
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
        refresh: boolean;
        promise: Promise<ModelCatalogSnapshot>;
      }
    | undefined;
  let nativePending: Promise<ModelCatalogSnapshot> | undefined;
  const assertCurrent = () =>
    assertPreparedModelRuntimeInputCurrent(params.agentFacts.input, params.isCurrent);
  const worker = withRemoteModelCatalogSnapshot(params.pluginGeneration.remoteCatalog, () =>
    createPreparedModelCatalogWorker({
      pluginRegistry: params.pluginGeneration.pluginRegistry,
      agentFacts: params.agentFacts,
      pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      preferBuiltPluginArtifacts: params.pluginGeneration.preferBuiltPluginArtifacts,
      isCurrent: params.isCurrent,
      retirementSignal: params.retirementSignal,
    }),
  );
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
  const publishCatalog = (
    candidate: PreparedModelCatalogCandidate,
    source: "provider" | "native",
  ) => {
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
    requestedProviderIds: readonly string[] | undefined,
    refresh: boolean,
  ): Promise<PreparedModelCatalogCandidate> => {
    const providerIds = requestedProviderIds
      ? [...preparedSyntheticAuthProviderScope(requestedProviderIds)]
      : undefined;
    return limitFullModelCatalogBuild(async () => {
      assertCurrent();
      const providers = providerIds ?? eligibleProviders;
      const {
        modelCatalog: workerCatalog,
        configuredRuntimeModels,
        runtimeModels,
        providerExpiries,
        hookRows,
      } = await worker.loadCatalog(
        providerIds,
        (error) => {
          attempt.failed(error, providers, "provider");
          recoverCatalogGeneration(error);
        },
        refresh,
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
              ...retry.discoveryDeadline(failed, expiresAt, retained?.providers.get(provider)),
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
      accountCatalog.reconcileAuth(discoveredAuth.authStore, (provider) =>
        scope.has(normalizeProvider(provider)),
      );
      setCatalogAuth(inventory.catalog, auth);
      return {
        inventory,
        configuredRuntimeModels,
        nativeCatalogAcquired: published.nativeCatalogAcquired,
      };
    });
  };

  const acquireNativeCatalog = (
    providerIds?: readonly string[],
    selection?: PreparedNativeModelSelection,
    refresh = false,
  ): Promise<ModelCatalogSnapshot> => {
    const captured = selection
      ? getPreparedModelRuntimeBorrowedSnapshot(params.pluginGeneration)
      : undefined;
    const borrowed =
      captured?.loadNativeModelCatalog === loadNativeModelCatalog ? captured : undefined;
    const assertLifetime = capturePreparedModelRuntimeLifetime();
    const isObservationCurrent = () => {
      assertLifetime();
      return borrowed
        ? getPreparedModelRuntimeBorrowedSnapshot(params.pluginGeneration) === borrowed
        : params.isCurrent();
    };
    const input = borrowed
      ? { ...params.agentFacts.input, config: borrowed.config }
      : params.agentFacts.input;
    const capturedCatalog = borrowed
      ? (readCapturedPreparedModelRuntimeCatalog(borrowed) ?? borrowed.modelCatalog)
      : undefined;
    const readCatalog = () =>
      (!params.isCurrent() ? capturedCatalog : undefined) ?? published.catalog ?? staticCatalog;
    const assertObservationCurrent = () =>
      assertPreparedModelRuntimeInputCurrent(input, isObservationCurrent);
    const readReadyCatalog = () => {
      assertObservationCurrent();
      const snapshot = readCatalog();
      const ready =
        !refresh &&
        isPreparedNativeModelCatalogReady({
          input,
          pluginGeneration: params.pluginGeneration,
          snapshot,
          selection,
          catalogAcquired: published.nativeCatalogAcquired,
        });
      // Readiness invokes plugin code, which may close the captured authority.
      assertObservationCurrent();
      return ready ? snapshot : undefined;
    };
    const readyCatalog = readReadyCatalog();
    if (readyCatalog) {
      return Promise.resolve(readyCatalog);
    }
    const previousNative = nativePending;
    let failedProviders: readonly string[] | undefined;
    const promise = (async () => {
      await previousNative?.catch(() => undefined);
      const settledCatalog = readReadyCatalog();
      if (settledCatalog) {
        return settledCatalog;
      }
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      if (params.isCurrent()) {
        attempt.setPending([], "native");
      }
      let discoveredProviders: string[] = [];
      let completed = false;
      const failures: Array<{ error: unknown; providers?: readonly string[] }> = [];
      const startupProviders = new Set(params.agentFacts.providerIds.map(normalizeProvider));
      const rawCatalog = await augmentPreparedModelCatalogWithAgentHarness({
        input,
        nativeSelection: selection,
        snapshot: params.isCurrent()
          ? (published.inventory?.catalog ?? params.catalogFacts.modelCatalog)
          : readCatalog(),
        normalizeProvider,
        preparedSnapshot: readCatalog(),
        pluginRegistry: params.pluginGeneration.pluginRegistry,
        includesProvider: providerIds
          ? (provider) => providerIds.includes(normalizeProvider(provider))
          : undefined,
        onDiscoveryStarted: (provider) => {
          if (params.isCurrent()) {
            attempt.setPending([normalizeProvider(provider)], "native");
          }
        },
        onError: (error, failedProviderIds) => {
          failures.push({ error, providers: failedProviderIds?.map(normalizeProvider) });
        },
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
      assertObservationCurrent();
      if (!params.isCurrent()) {
        if (!completed && failures.length) {
          throw failures[0]!.error;
        }
        const catalog = projectInventory(rawCatalog, params.catalogFacts.configuredRuntimeModels);
        setCatalogAuth(
          catalog,
          getPreparedModelFullCatalogAuth(capturedCatalog ?? staticCatalog) ?? currentAuth,
        );
        assertObservationCurrent();
        return catalog;
      }
      // Selected native membership is a foreground harness fact, not a provider-auth refresh.
      // Full inventory acquisition alone discovers additional paired provider credentials.
      const nativeAuth =
        !selection && completed && discoveredProviders.length
          ? await worker.loadAuth({ providerIds: discoveredProviders }, recoverCatalogGeneration)
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
      const acquiredNative = latest.nativeCatalogAcquired || (!selection && !providerIds);
      const nextInventory =
        completed || failures.length
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
        if (nativeAuth) {
          accountCatalog.reconcileAuth(nativeAuth.authStore, (provider) =>
            nativeScope.has(normalizeProvider(provider)),
          );
        }
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
      const change = publishCatalog(
        { ...latest, inventory: nextInventory, nativeCatalogAcquired: acquiredNative },
        "native",
      );
      if (params.isPublished?.() !== false) {
        notifyPreparedModelCatalogPublication(change);
      }
      if (!completed && failures.length && (selection || refresh)) {
        failedProviders = failures.flatMap((failure) => failure.providers ?? []);
        throw failures[0]!.error;
      }
      return published.catalog ?? staticCatalog;
    })()
      .catch((error: unknown) => {
        attempt.failed(error, failedProviders ?? providerIds, "native");
        if (params.isCurrent() && published.catalog) {
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

  const authOwner = {
    pluginGeneration: params.pluginGeneration,
    accountCatalog,
    normalizeProvider,
    assertCurrent,
    readAuth: () =>
      getPreparedModelFullCatalogAuth(published.catalog ?? staticCatalog) ?? currentAuth,
    refreshAuth: (scope: Parameters<typeof worker.loadAuth>[0]) =>
      worker.loadAuth(scope, recoverCatalogGeneration),
  };
  const recheckNativeLogin = createNativeLoginRecheck(
    authOwner,
    params,
    eligibleProviders,
    (auth) => {
      const inventory = {
        runtimeModels: new Map(),
        providers: new Map(),
        discoveryOrigins: [],
        ...published.inventory,
        key: inventoryKey,
        pluginFingerprint,
        nativeSource,
        catalog: { ...(published.inventory?.catalog ?? params.catalogFacts.modelCatalog) },
      };
      setCatalogAuth(inventory.catalog, auth);
      const change = publishCatalog({ ...published, inventory }, "native");
      notifyPreparedModelCatalogPublication(params.isPublished?.() === false ? undefined : change);
    },
  );
  const refreshExpiredModelCatalog = () => {
    assertCurrent();
    recheckNativeLogin();
    if (pending || !published.inventory) {
      return;
    }
    const now = Date.now();
    const providers = [...published.inventory.providers]
      .filter(([, { expiresAt }]) => expiresAt !== undefined && expiresAt <= now)
      .map(([provider]) => provider);
    if (providers.length) {
      void acquireCatalog({ providerIds: providers, refresh: true }, "expiry").catch(
        () => undefined,
      );
    }
  };
  const acquireCatalog = async (
    options: PreparedModelCatalogRefreshOptions = {},
    trigger: "request" | "expiry" = "request",
  ): Promise<ModelCatalogSnapshot> => {
    assertCurrent();
    // Expiry renews inventory without invalidating still-fresh sibling metadata feeds.
    const refreshResponses = options.refresh === true && trigger === "request";
    if (
      !options.refresh &&
      !options.changedOnly &&
      published.catalog &&
      eligibleProviders.every((provider) => published.inventory?.providers.has(provider))
    ) {
      refreshExpiredModelCatalog();
      return await acquireNativeCatalog();
    }
    const requestedProviders = [
      ...new Set((options.providerIds ?? eligibleProviders).map(normalizeProvider)),
    ];
    const providers = options.changedOnly
      ? listChangedProviders(published.inventory, options.providerIds)
      : requestedProviders;
    // A changed-only pass without provider inventory is a cold start: acquire what a refresh
    // would, including hosted rows for providers without credentials.
    const fullRefresh =
      !options.providerIds && (!options.changedOnly || !published.inventory?.providers.size);
    const includeNative = trigger === "request" && hasNativeCatalog && !options.changedOnly;
    const nativeScope = options.providerIds ? requestedProviders : undefined;
    const nativeProviders = includeNative ? nativeScope : [];
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
      // An ordinary acquisition may consume a warm HTTP response; it cannot satisfy refresh.
      if (coversProviders && coversNative && (!refreshResponses || current.refresh)) {
        return current.promise;
      }
      await current.promise.catch(() => undefined);
      return acquireCatalog(options, trigger);
    }
    attempt.setPending(fullRefresh || providers.length ? providers : undefined);
    const providerIds = fullRefresh ? undefined : providers;
    const promise = (async () => {
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      if (fullRefresh || providers.length) {
        const candidate = await acquireProviderCatalog(providerIds, refreshResponses).catch(
          (error: unknown) => {
            attempt.failed(error, providers, "provider");
            throw error;
          },
        );
        // Provider facts belong to their completed acquisition; optional native failure cannot
        // discard them. Native discovery starts from this accepted publication.
        attempt.published(providerIds, "provider", () => publishCatalog(candidate, "provider"));
      }
      if (includeNative) {
        return await acquireNativeCatalog(nativeScope, undefined, options.refresh);
      }
      return published.catalog ?? staticCatalog;
    })().finally(() => {
      pending = undefined;
      retryFailedDiscovery();
    });
    pending = { providers: providerIds, nativeProviders, refresh: refreshResponses, promise };
    return promise;
  };
  const retryFailedDiscovery = retry.createFailedDiscoveryRetry(
    params.retirementSignal,
    () => (pending ? undefined : published.inventory),
    (options) => acquireCatalog(options, "expiry"),
  );
  const loadNativeModelCatalog = async (selection?: PreparedNativeModelSelection) =>
    await retry.waitForDiscovery(
      acquireNativeCatalog(
        selection ? [normalizeProvider(selection.provider)] : undefined,
        selection,
      ),
      () => published.catalog ?? staticCatalog,
      Boolean(selection),
    );
  return {
    accountCatalog,
    initialAuth: currentAuth,
    isCurrent: params.isCurrent,
    withRefreshStatus: attempt.withRefreshStatus,
    loadAuth: (scope) => loadScopedModelCatalogAuth(authOwner, scope),
    readFullModelCatalog: () => {
      assertCurrent();
      return published.catalog;
    },
    refreshExpiredModelCatalog,
    recheckNativeLogin,
    readPublishedModels: () => {
      assertCurrent();
      return published.inventory?.runtimeModels;
    },
    loadNativeModelCatalog,
    // Standalone commands cannot publish background discovery after their process exits.
    loadFullModelCatalog: (options) =>
      retry.waitForDiscovery(
        acquireCatalog(options),
        () => published.catalog ?? staticCatalog,
        options?.refresh && (options.wait || params.inventoryOwner.provenance === "standalone"),
      ),
  };
}
