import { isDeepStrictEqual } from "node:util";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
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
  // Publication owners alone can prove that model facts stayed unchanged.
  | {
      phase: "catalog-published";
      modelFactsChanged?: boolean;
      refreshStatusChanged?: boolean;
    }
  | { phase: "catalog-failed"; error: Error; modelFactsChanged?: boolean };

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

/** Completes catalog attempts without withdrawing their prepared turn runtime. */
export function createCatalogAttemptReporter(
  owner: Pick<PreparedModelRuntimeOwner, "catalogAttempt">,
  source: PreparedModelCatalogAttempt["source"],
  isCurrent: () => boolean,
  beforeProviderFailure: () => void,
): {
  setPending: (
    providers: readonly string[] | undefined,
    kind?: PreparedModelCatalogAcquisitionKind,
  ) => void;
  published: (
    providers?: readonly string[],
    kind?: PreparedModelCatalogAcquisitionKind,
    publication?: () => CatalogPublicationChange,
  ) => void;
  failed: (
    error: unknown,
    providers?: readonly string[],
    kind?: PreparedModelCatalogAcquisitionKind,
  ) => void;
  withRefreshStatus: (catalog: ModelCatalogSnapshot) => ModelCatalogSnapshot;
} {
  // Compatible reloads share live status; replacement sources start without the old error.
  const attempt: PreparedModelCatalogAttempt =
    owner.catalogAttempt && isDeepStrictEqual(owner.catalogAttempt.source, source)
      ? owner.catalogAttempt
      : { source, failedProviders: { provider: new Set(), native: new Set() } };
  const pendingProviders: Record<
    PreparedModelCatalogAcquisitionKind,
    readonly string[] | undefined
  > = {
    provider: undefined,
    native: undefined,
  };
  const pendingCount = () =>
    (pendingProviders.provider?.length ?? 0) + (pendingProviders.native?.length ?? 0);
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
        error: toStringifiedError(error),
        modelFactsChanged: false,
      });
    }
  };
  const hasFailedProviders = () =>
    attempt.failedProviders.provider.size > 0 || attempt.failedProviders.native.size > 0;
  return {
    setPending: (providers, kind = "provider") => {
      pendingProviders[kind] = providers;
    },
    withRefreshStatus: (catalog) => {
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
        get: () =>
          pendingCount()
            ? [
                ...new Set([
                  ...(pendingProviders.provider ?? []),
                  ...(pendingProviders.native ?? []),
                ]),
              ]
            : undefined,
      });
      // Keep the status live on retained inventory without copying an error into its successor.
      Object.defineProperty(catalog, "refreshFailed", {
        enumerable: true,
        configurable: true,
        get: () =>
          hasFailedProviders() ||
          nativeOutcomes.some((outcome) => outcome.status === "unavailable") ||
          catalog.providerOutcomes?.some((outcome) => outcome.status === "unavailable") ||
          undefined,
      });
      return catalog;
    },
    published: (providers, kind, publication) => {
      const previouslyFailed = hasFailedProviders();
      const previouslyPendingCount = pendingCount();
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
      notifyPreparedModelCatalogPublication(
        publication?.(),
        previouslyPendingCount !== pendingCount() || previouslyFailed !== hasFailedProviders(),
      );
    },
    failed,
  };
}

/** Observes committed prepared model/auth generations without starting discovery. */
export function registerPreparedModelRuntimePublicationListener(
  listener: (event: PreparedModelRuntimePublicationEvent) => void,
): () => void {
  publicationListeners.add(listener);
  return () => publicationListeners.delete(listener);
}

export function notifyPreparedModelRuntimePublication(
  event: PreparedModelRuntimePublicationEvent,
): void {
  for (const listener of publicationListeners) {
    try {
      listener(event);
    } catch (error) {
      log.warn(`prepared model runtime publication listener failed: ${String(error)}`);
    }
  }
}

export function resetPreparedModelRuntimePublicationListenersForTest(): void {
  publicationListeners.clear();
}
