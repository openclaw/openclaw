import type {
  PreparedModelCatalogInventory,
  PreparedModelCatalogProviderFacts,
  PreparedModelCatalogRefreshOptions,
} from "./prepared-model-runtime.types.js";

// Failed discovery keeps saved rows; its catalog owner retries off the read path with capped backoff.
const FAILED_DISCOVERY_RETRY_MS = 30_000;
const FAILED_DISCOVERY_RETRY_MAX_MS = 30 * 60_000;

function failedDiscoveryFacts(previous: PreparedModelCatalogProviderFacts | undefined) {
  const discoveryFailures = (previous?.discoveryFailures ?? 0) + 1;
  const delay = FAILED_DISCOVERY_RETRY_MS * 2 ** (discoveryFailures - 1);
  return {
    discoveryFailures,
    expiresAt: Date.now() + Math.min(delay, FAILED_DISCOVERY_RETRY_MAX_MS),
  };
}

/** A successful discovery keeps its cache deadline; a failed one gets a backed-off retry deadline. */
export function discoveryDeadline(
  failed: boolean | undefined,
  expiresAt: number | undefined,
  previous: PreparedModelCatalogProviderFacts | undefined,
): Pick<PreparedModelCatalogProviderFacts, "expiresAt" | "discoveryFailures"> {
  if (failed) {
    return failedDiscoveryFacts(previous);
  }
  return expiresAt === undefined ? {} : { expiresAt };
}

/** Failed renewal retains rows, but replaces a successful deadline with its retry deadline. */
export function recordFailedDiscovery(
  inventory: PreparedModelCatalogInventory,
  providerIds: Iterable<string> = inventory.providers.keys(),
): PreparedModelCatalogInventory {
  const providers = new Map(inventory.providers);
  for (const provider of providerIds) {
    const facts = providers.get(provider);
    if (facts) {
      providers.set(provider, { ...facts, ...failedDiscoveryFacts(facts) });
    }
  }
  return { ...inventory, providers };
}

/**
 * Keeps one timer at the earliest failed-provider deadline of the current catalog owner.
 * Every settled acquisition re-arms it, so a retry never joins the acquisition that failed.
 * `readIdleInventory` returns nothing while an acquisition is pending.
 */
export function createFailedDiscoveryRetry(
  retirementSignal: AbortSignal,
  readIdleInventory: () => PreparedModelCatalogInventory | undefined,
  acquire: (
    options: PreparedModelCatalogRefreshOptions,
    acquireNative: boolean,
  ) => Promise<unknown>,
) {
  let timer: NodeJS.Timeout | undefined;
  const failedDeadlines = () =>
    [...(readIdleInventory()?.providers ?? [])].flatMap(([provider, facts]) =>
      facts.discoveryFailures && facts.expiresAt !== undefined
        ? [{ provider, expiresAt: facts.expiresAt }]
        : [],
    );
  const arm = (): void => {
    clearTimeout(timer);
    const failed = failedDeadlines();
    if (retirementSignal.aborted || !failed.length) {
      return;
    }
    const due = Math.min(...failed.map(({ expiresAt }) => expiresAt));
    timer = setTimeout(
      () => {
        const now = Date.now();
        const providerIds = failedDeadlines()
          .filter(({ expiresAt }) => expiresAt <= now)
          .map(({ provider }) => provider);
        if (retirementSignal.aborted || !providerIds.length) {
          arm();
          return;
        }
        // The acquisition re-arms when it settles.
        void acquire({ providerIds, refresh: true }, false).catch(() => undefined);
      },
      Math.max(0, due - Date.now()),
    ).unref();
  };
  retirementSignal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  // A compatible reload retains failed facts; its new owner resumes their retry.
  arm();
  return arm;
}
