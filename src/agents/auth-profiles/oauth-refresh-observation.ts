import path from "node:path";
import { retainCurrentWorkerNativeSection } from "../../infra/worker-task-native-sections.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import { observeOAuthRefreshSettlement } from "./oauth-refresh-fence.js";

type ActiveOAuthRefresh = {
  targets: Map<string, ReturnType<typeof createRefreshTarget>>;
  profileId: string;
  provider: string;
  claimId: string;
  generation: string;
  settling: boolean;
  settled: Promise<void>;
};

function createRefreshTarget() {
  const retired = createDeferredCore();
  return { current: true, retired };
}

// These are observations of the refresh owner's lifetime, never credential or write authority.
const activeRefreshes = new Set<ActiveOAuthRefresh>();

/** Register before publishing a fence; release only after durable settlement or claim rollback. */
export function beginOAuthRefreshObservation(params: {
  databasePath: string;
  profileId: string;
  provider: string;
  claimId: string;
  generation: string;
}) {
  const completion = createDeferredCore();
  const refresh: ActiveOAuthRefresh = {
    targets: new Map([[path.resolve(params.databasePath), createRefreshTarget()]]),
    profileId: params.profileId,
    provider: params.provider,
    claimId: params.claimId,
    generation: params.generation,
    settling: false,
    settled: completion.promise,
  };
  // Retirement must not discard the only process holding the real refresh token.
  // Admission is synchronous so a canceled worker cannot publish a new fence.
  const releaseNativeSection = retainCurrentWorkerNativeSection();
  activeRefreshes.add(refresh);
  return {
    includeDatabase: (databasePath: string) => {
      const key = path.resolve(databasePath);
      const existing = refresh.targets.get(key);
      const target = existing?.current ? existing : createRefreshTarget();
      refresh.targets.set(key, target);
      return () => {
        target.current = false;
        target.retired.resolve();
      };
    },
    beginSettlement: () => {
      refresh.settling = true;
    },
    finish: () => {
      activeRefreshes.delete(refresh);
      completion.resolve();
      releaseNativeSection();
    },
  };
}

/** Retire only replaced claim targets; the producer still owns all remaining cleanup. */
export function publishOAuthRefreshClaimIdentities(
  databasePath: string,
  claimIds: ReadonlyMap<string, string | undefined>,
): void {
  const key = path.resolve(databasePath);
  for (const refresh of activeRefreshes) {
    if (!claimIds.has(refresh.profileId)) {
      continue;
    }
    const target = refresh.targets.get(key);
    if (claimIds.get(refresh.profileId) === refresh.claimId) {
      // A guarded rollback can restore this claim without reattaching retired waiters.
      if (target && !target.current) {
        refresh.targets.set(key, createRefreshTarget());
      }
      continue;
    }
    if (refresh.settling) {
      continue;
    }
    if (target?.current) {
      target.current = false;
      target.retired.resolve();
    }
  }
}

/** Capture matching work now, without reading credentials or following subsequent refreshes. */
export function captureOAuthRefreshSettlement(params: {
  databasePaths: readonly string[];
  profileId?: string;
  matchesProvider: (provider: string) => boolean;
  localPin?: { databasePath: string; generation?: string };
}): ((signal?: AbortSignal) => Promise<void>) | undefined {
  const paths = new Set(params.databasePaths.map((databasePath) => path.resolve(databasePath)));
  const pending = [...activeRefreshes].flatMap((refresh) => {
    if (
      (params.profileId && refresh.profileId !== params.profileId) ||
      !params.matchesProvider(refresh.provider)
    ) {
      return [];
    }
    return [...refresh.targets].flatMap(([databasePath, target]) =>
      target.current &&
      paths.has(databasePath) &&
      (!params.localPin ||
        databasePath === params.localPin.databasePath ||
        params.localPin.generation === refresh.generation)
        ? [Promise.race([refresh.settled, target.retired.promise])]
        : [],
    );
  });
  if (pending.length === 0) {
    return undefined;
  }
  const settled = Promise.all(pending).then(() => {});
  return async (signal) => {
    await observeOAuthRefreshSettlement(
      "runtime auth profile read",
      OAUTH_REFRESH_CALL_TIMEOUT_MS,
      settled,
      signal,
    );
  };
}
