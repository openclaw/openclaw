import { isDeepStrictEqual } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelCatalogAcquisitionKind,
  PreparedModelCatalogAttempt,
  PreparedModelRuntimeOwner,
} from "./prepared-model-runtime.types.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");

type PreparedModelRuntimePublicationEvent =
  | { phase: "invalidated"; modelFactsChanged?: false; replacement?: Promise<void> }
  | { phase: "published"; modelFactsChanged?: false }
  | { phase: "failed"; error: Error }
  | { phase: "catalog-status"; modelFactsChanged: false }
  | { phase: "catalog-observation"; modelFactsChanged: false; agentId: string }
  // Publication owners alone can prove that model facts stayed unchanged.
  | {
      phase: "catalog-published";
      modelFactsChanged?: boolean;
      refreshStatusChanged?: boolean;
    }
  | { phase: "catalog-failed"; modelFactsChanged?: boolean };

type CatalogPublication = {
  catalog: ModelCatalogSnapshot | undefined;
};
type CatalogPublicationChange = {
  previous: CatalogPublication;
  current: CatalogPublication;
  staticCatalog: ModelCatalogSnapshot;
};

/** Reports model changes only after the catalog owner commits its complete publication. */
export function notifyPreparedModelCatalogPublication(
  change: CatalogPublicationChange | undefined,
  refreshStatusChanged = false,
): void {
  notifyPreparedModelRuntimePublication({
    phase: "catalog-published",
    modelFactsChanged:
      change !== undefined &&
      (change.previous.catalog ?? change.staticCatalog) !==
        (change.current.catalog ?? change.staticCatalog),
    ...(refreshStatusChanged ? { refreshStatusChanged: true } : {}),
  });
}

const publicationListeners = new Set<(event: PreparedModelRuntimePublicationEvent) => void>();

type PendingCatalogProviders = Record<
  PreparedModelCatalogAcquisitionKind,
  readonly string[] | undefined
>;

function countPendingProviders(pending: PendingCatalogProviders): number {
  return (pending.provider?.length ?? 0) + (pending.native?.length ?? 0);
}

// Catalog getters can outlive acquisition. Their closures retain only status
// facts, not the reporter context with its owner, authority, and failure callback.
function createPendingProvidersReader(pending: PendingCatalogProviders) {
  return () =>
    countPendingProviders(pending)
      ? [...new Set([...(pending.provider ?? []), ...(pending.native ?? [])])]
      : undefined;
}

function createRefreshFailureReader(
  failed: PreparedModelCatalogAttempt["failedProviders"],
  nativeOutcomes: NonNullable<ModelCatalogSnapshot["providerOutcomes"]>,
  catalog: ModelCatalogSnapshot,
) {
  return () =>
    failed.provider.size > 0 ||
    failed.native.size > 0 ||
    nativeOutcomes.some((outcome) => outcome.status === "unavailable") ||
    catalog.providerOutcomes?.some((outcome) => outcome.status === "unavailable") ||
    undefined;
}

/** Completes catalog attempts without withdrawing their prepared turn runtime. */
export function createCatalogAttemptReporter(
  owner: Pick<PreparedModelRuntimeOwner, "catalogAttempt">,
  source: PreparedModelCatalogAttempt["source"],
  isCurrent: () => boolean,
  beforeProviderFailure: () => void,
) {
  // Compatible reloads share live status; replacement sources start without the old error.
  const attempt: PreparedModelCatalogAttempt =
    owner.catalogAttempt && isDeepStrictEqual(owner.catalogAttempt.source, source)
      ? owner.catalogAttempt
      : { source, failedProviders: { provider: new Set(), native: new Set() } };
  const pendingProviders: PendingCatalogProviders = {
    provider: undefined,
    native: undefined,
  };
  const readPendingProviders = createPendingProvidersReader(pendingProviders);
  const failed = (
    error: unknown,
    providers?: readonly string[],
    kind: PreparedModelCatalogAcquisitionKind = "provider",
  ) => {
    if (isCurrent() && !(error instanceof PreparedModelRuntimePublicationSupersededError)) {
      const pending = pendingProviders[kind];
      const scope = providers ?? pending ?? [];
      const failedScope = scope.length ? scope : [undefined];
      // Empty scopes are admitted work too. Only idle, already-recorded failures are duplicates.
      if (
        pending === undefined &&
        failedScope.every((provider) => attempt.failedProviders[kind].has(provider))
      ) {
        return;
      }
      if (kind === "provider") {
        beforeProviderFailure();
      }
      for (const provider of failedScope) {
        attempt.failedProviders[kind].add(provider);
      }
      pendingProviders[kind] = undefined;
      owner.catalogAttempt = attempt;
      notifyPreparedModelRuntimePublication({
        phase: "catalog-failed",
        modelFactsChanged: false,
      });
    }
  };
  const hasFailedProviders = () =>
    attempt.failedProviders.provider.size > 0 || attempt.failedProviders.native.size > 0;
  return {
    setPending: (
      providers: readonly string[] | undefined,
      kind: PreparedModelCatalogAcquisitionKind = "provider",
    ) => {
      const previous = readPendingProviders();
      pendingProviders[kind] = providers;
      if (!isDeepStrictEqual(previous, readPendingProviders())) {
        notifyPreparedModelRuntimePublication({
          phase: "catalog-status",
          modelFactsChanged: false,
        });
      }
    },
    withRefreshStatus: (catalog: ModelCatalogSnapshot) => {
      const nativeOutcomes = Object.values(catalog.nativeProviderOutcomes ?? {}).flat();
      // Auth rejection leaves inventory incomplete without making its refresh fail.
      // Provider renewal does not retry a failed native inventory.
      if (
        attempt.failedProviders.native.size > 0 ||
        nativeOutcomes.some((outcome) => outcome.status !== "ready")
      ) {
        catalog.authoritative = false;
      }
      Object.defineProperty(catalog, "pendingProviders", {
        enumerable: true,
        configurable: true,
        get: readPendingProviders,
      });
      // Keep the status live on retained inventory without copying an error into its successor.
      Object.defineProperty(catalog, "refreshFailed", {
        enumerable: true,
        configurable: true,
        get: createRefreshFailureReader(attempt.failedProviders, nativeOutcomes, catalog),
      });
      return catalog;
    },
    published: (
      providers?: readonly string[],
      kind?: PreparedModelCatalogAcquisitionKind,
      publication?: () => CatalogPublicationChange,
    ) => {
      const previouslyFailed = hasFailedProviders();
      const previouslyPendingCount = countPendingProviders(pendingProviders);
      const acquisitionKind = kind ?? "provider";
      const remaining = providers
        ? pendingProviders[acquisitionKind]?.filter((provider) => !providers.includes(provider))
        : undefined;
      pendingProviders[acquisitionKind] = remaining?.length ? remaining : undefined;
      if (providers) {
        for (const provider of providers) {
          attempt.failedProviders[acquisitionKind].delete(provider);
        }
      } else {
        attempt.failedProviders[acquisitionKind].clear();
      }
      owner.catalogAttempt = attempt;
      const change = publication?.();
      notifyPreparedModelCatalogPublication(
        change,
        previouslyPendingCount !== countPendingProviders(pendingProviders) ||
          previouslyFailed !== hasFailedProviders(),
      );
    },
    failed,
  };
}

/** Observes committed prepared model/auth generations without starting discovery. */
export function registerPreparedModelRuntimePublicationListener(
  listener: (event: PreparedModelRuntimePublicationEvent) => void,
): () => void {
  return registerListener(publicationListeners, listener);
}

export function notifyPreparedModelRuntimePublication(
  event: PreparedModelRuntimePublicationEvent,
): void {
  notifyListeners(publicationListeners, event, (error) => {
    log.warn(`prepared model runtime publication listener failed: ${String(error)}`);
  });
}
