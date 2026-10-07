import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import type {
  PreparedAccountCatalogAccess,
  PreparedModelCatalogAuth,
  PreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { replacePreparedModelCatalogAuth } from "./prepared-model-runtime.catalog-auth.js";
import { preparedSyntheticAuthProviderScope } from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelCatalogInventory,
  PreparedNativeModelSelection,
} from "./prepared-model-runtime.types.js";

export function createPreparedNativeCatalogDiscoveryTracker(params: {
  startupProviders: ReadonlySet<string>;
  normalizeProvider: (provider: string) => string;
}) {
  let completed = false;
  let rows: readonly ModelCatalogEntry[] | undefined;
  let providers: string[] = [];
  return {
    get completed() {
      return completed;
    },
    get rows() {
      return rows;
    },
    get providers() {
      return providers;
    },
    onCompleted(nextRows: readonly ModelCatalogEntry[]) {
      completed = true;
      rows = nextRows;
      providers = [
        ...new Set(
          nextRows
            .map((entry) => params.normalizeProvider(entry.provider))
            .filter((provider) => !params.startupProviders.has(provider)),
        ),
      ];
    },
  };
}

function createPreparedNativeCatalogInventory(params: {
  completed: boolean;
  rawCatalog: ModelCatalogSnapshot;
  latestInventory: PreparedModelCatalogInventory | undefined;
  fallbackCatalog: ModelCatalogSnapshot;
  key: string;
  pluginFingerprint: string;
  nativeSource: string;
}): PreparedModelCatalogInventory | undefined {
  if (!params.completed) {
    return params.latestInventory;
  }
  return {
    catalog: {
      ...params.rawCatalog,
      authoritative: (params.latestInventory?.catalog ?? params.fallbackCatalog).authoritative,
    },
    runtimeModels: params.latestInventory?.runtimeModels ?? new Map(),
    key: params.key,
    pluginFingerprint: params.pluginFingerprint,
    nativeSource: params.nativeSource,
    providers: params.latestInventory?.providers ?? new Map(),
    discoveryOrigins: params.latestInventory?.discoveryOrigins ?? [],
  };
}

type PreparedNativeSelectionDiscoveryStatus = {
  outcomes: readonly ProviderCatalogOutcome[];
  failedProviders: readonly string[];
  unknownProviderFailure: boolean;
};

function createPreparedNativeSelectionDiscoveryStatus(params: {
  catalog: ModelCatalogSnapshot;
  selection: PreparedNativeModelSelection | undefined;
  failures: readonly { providers?: readonly string[] }[];
  normalizeProvider: (provider: string) => string;
}): PreparedNativeSelectionDiscoveryStatus {
  return {
    outcomes: params.selection
      ? (params.catalog.nativeProviderOutcomes?.[params.selection.runtime] ?? [])
      : [],
    failedProviders: params.failures.flatMap(({ providers }) =>
      (providers ?? []).map(params.normalizeProvider),
    ),
    unknownProviderFailure: params.failures.some(({ providers }) => providers === undefined),
  };
}

function isPreparedNativeSelectionDiscoveryReady(params: {
  rows: readonly ModelCatalogEntry[];
  selection: PreparedNativeModelSelection;
  catalog: ModelCatalogSnapshot;
  failures: readonly { error: unknown; providers?: readonly string[] }[];
  normalizeProvider: (provider: string) => string;
}): boolean {
  const selectedProvider = params.normalizeProvider(params.selection.provider);
  const status = createPreparedNativeSelectionDiscoveryStatus({
    catalog: params.catalog,
    selection: params.selection,
    failures: params.failures,
    normalizeProvider: params.normalizeProvider,
  });
  return (
    params.rows.some(
      (entry) =>
        params.normalizeProvider(entry.provider) === selectedProvider &&
        entry.id === params.selection.modelId &&
        entry.nativeRuntime === params.selection.runtime,
    ) &&
    !status.unknownProviderFailure &&
    !status.failedProviders.includes(selectedProvider) &&
    !status.outcomes.some(
      (outcome) =>
        params.normalizeProvider(outcome.provider) === selectedProvider &&
        outcome.status !== "ready",
    )
  );
}

export function isCompletedPreparedNativeSelectionDiscoveryReady(params: {
  rows: readonly ModelCatalogEntry[] | undefined;
  selection: PreparedNativeModelSelection | undefined;
  catalog: ModelCatalogSnapshot;
  failures: readonly { error: unknown; providers?: readonly string[] }[];
  normalizeProvider: (provider: string) => string;
}): boolean {
  return Boolean(
    params.selection &&
    params.rows &&
    isPreparedNativeSelectionDiscoveryReady({
      rows: params.rows,
      selection: params.selection,
      catalog: params.catalog,
      failures: params.failures,
      normalizeProvider: params.normalizeProvider,
    }),
  );
}

export function reportPreparedNativeCatalogAttempt(params: {
  profileScopedSelection: boolean;
  completed: boolean;
  providers?: readonly string[];
  failures: readonly { error: unknown; providers?: readonly string[] }[];
  attempt: {
    setPending: (providers: readonly string[] | undefined, kind?: "provider" | "native") => void;
    published: (providers?: readonly string[], kind?: "provider" | "native") => void;
    failed: (error: unknown, providers?: readonly string[], kind?: "provider" | "native") => void;
  };
}): void {
  if (params.profileScopedSelection) {
    return;
  }
  if (params.completed) {
    params.attempt.published(params.providers, "native");
  } else {
    params.attempt.setPending(undefined, "native");
  }
  for (const failure of params.failures) {
    params.attempt.failed(failure.error, failure.providers, "native");
  }
}

type PreparedNativeCatalogAttemptReporter = {
  setPending: (providers: readonly string[] | undefined, kind?: "provider" | "native") => void;
  failed: (error: unknown, providers?: readonly string[], kind?: "provider" | "native") => void;
  withRefreshStatus: (catalog: ModelCatalogSnapshot) => ModelCatalogSnapshot;
};

export function setPreparedNativeCatalogPending(params: {
  profileScopedSelection: boolean;
  attempt: PreparedNativeCatalogAttemptReporter;
  providers?: readonly string[];
}): void {
  if (!params.profileScopedSelection) {
    params.attempt.setPending(params.providers, "native");
  }
}

export function createPreparedNativeCatalogDiscoveryPendingHandler(params: {
  profileScopedSelection: boolean;
  attempt: PreparedNativeCatalogAttemptReporter;
  normalizeProvider: (provider: string) => string;
}): (provider: string) => void {
  return (provider) =>
    setPreparedNativeCatalogPending({
      profileScopedSelection: params.profileScopedSelection,
      attempt: params.attempt,
      providers: [params.normalizeProvider(provider)],
    });
}

export function reportPreparedNativeCatalogFailure(params: {
  profileScopedSelection: boolean;
  attempt: PreparedNativeCatalogAttemptReporter;
  error: unknown;
  providers?: readonly string[];
  catalog?: ModelCatalogSnapshot;
}): void {
  if (!params.profileScopedSelection) {
    params.attempt.failed(params.error, params.providers, "native");
    if (params.catalog) {
      params.attempt.withRefreshStatus(params.catalog);
    }
  }
}

export function applyPreparedNativeCatalogResult(params: {
  profileScopedSelection: boolean;
  completed: boolean;
  rawCatalog: ModelCatalogSnapshot;
  latestInventory: PreparedModelCatalogInventory | undefined;
  fallbackCatalog: ModelCatalogSnapshot;
  key: string;
  pluginFingerprint: string;
  nativeSource: string;
  nativeCatalogAcquired: boolean;
  auth: PreparedModelCatalogAuth;
  nativeAuth?: PreparedModelRuntimeAuth;
  discoveredProviders: readonly string[];
  normalizeProvider: (provider: string) => string;
  accountCatalog: Pick<PreparedAccountCatalogAccess, "reconcileAuth">;
  setCatalogAuth: (catalog: ModelCatalogSnapshot, auth: PreparedModelCatalogAuth) => void;
  attempt: Parameters<typeof reportPreparedNativeCatalogAttempt>[0]["attempt"];
  providerIds?: readonly string[];
  failures: readonly { error: unknown; providers?: readonly string[] }[];
  publish: (
    inventory: PreparedModelCatalogInventory | undefined,
    nativeCatalogAcquired: boolean,
  ) => void;
}): void {
  const nativeScope = preparedSyntheticAuthProviderScope(params.discoveredProviders);
  const catalogAuth = params.nativeAuth
    ? replacePreparedModelCatalogAuth(params.auth, params.nativeAuth, (provider) =>
        nativeScope.has(params.normalizeProvider(provider)),
      )
    : params.auth;
  const acquiredNative = params.nativeCatalogAcquired;
  const nextInventory = params.profileScopedSelection
    ? params.latestInventory
    : createPreparedNativeCatalogInventory({
        completed: params.completed,
        rawCatalog: params.rawCatalog,
        latestInventory: params.latestInventory,
        fallbackCatalog: params.fallbackCatalog,
        key: params.key,
        pluginFingerprint: params.pluginFingerprint,
        nativeSource: params.nativeSource,
      });
  if (nextInventory && !params.profileScopedSelection) {
    if (params.nativeAuth) {
      params.accountCatalog.reconcileAuth(params.nativeAuth.authStore, (provider) =>
        nativeScope.has(params.normalizeProvider(provider)),
      );
    }
    params.setCatalogAuth(nextInventory.catalog, catalogAuth);
  }
  reportPreparedNativeCatalogAttempt({
    profileScopedSelection: params.profileScopedSelection,
    completed: params.completed,
    providers: params.providerIds,
    failures: params.failures,
    attempt: params.attempt,
  });
  if (!params.profileScopedSelection) {
    params.publish(nextInventory, acquiredNative);
  }
}
