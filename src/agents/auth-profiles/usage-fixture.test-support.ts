import { vi } from "vitest";
import type { AuthProfileUsageReceipt } from "./store.worker-contract.js";
import type { AuthProfileStore } from "./types.js";
import {
  reduceAuthProfileFailure,
  type PersonalAuthProfileUsageReduction,
} from "./usage-reduction.js";

export const storeMocks = {
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(
    (params: { agentDir?: string }) => params.agentDir,
  ),
  saveAuthProfileStore: vi.fn(),
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn().mockResolvedValue(null),
};

export const usageMocks = {
  withAuthProfileUsage: vi.fn<typeof import("./usage-write.js").withAuthProfileUsage>(),
  readFresh: vi.fn<() => AuthProfileStore | undefined>(),
  record:
    vi.fn<
      (
        store: AuthProfileStore,
        profileId: string,
        reduction: PersonalAuthProfileUsageReduction,
      ) => Promise<AuthProfileUsageReceipt | null>
    >(),
};

export function resetAuthProfileUsageMocks() {
  usageMocks.readFresh.mockReset();
  usageMocks.withAuthProfileUsage
    .mockReset()
    .mockImplementation(async (store, profileId, _agentDir, consume) =>
      consume({
        observed: structuredClone(usageMocks.readFresh() ?? store),
        inherited: false,
        record: (reduction) => usageMocks.record(store, profileId, reduction),
      }),
    );
  usageMocks.record.mockReset().mockImplementation(async (store, profileId, reduction) => {
    if (reduction.kind !== "failure") {
      throw new Error("Failure planning fixture received a success reduction");
    }
    const fresh = structuredClone(usageMocks.readFresh() ?? store);
    const previous = fresh.usageStats?.[profileId];
    const now = Date.now();
    // Only transport is replaced: provider observations feed the same worker reducer.
    const next = reduceAuthProfileFailure(fresh.profiles[profileId], previous, reduction, now);
    if (next) {
      fresh.usageStats = { ...fresh.usageStats, [profileId]: next };
      store.usageStats = { ...store.usageStats, [profileId]: next };
    }
    return {
      store: fresh,
      result: next ? { previous, next, now } : undefined,
      publication: {
        credentialsChanged: false,
        profileSetChanged: false,
        stateChanged: Boolean(next),
        selectionChanged: Boolean(next),
        profileIds: [],
      },
    };
  });
}

export function mockLockedUpdateForStore(store: AuthProfileStore): void {
  usageMocks.readFresh.mockReturnValue(store);
  storeMocks.loadAuthProfileStoreWithoutExternalProfiles.mockImplementation(() => store);
  storeMocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
    async (lockParams: { updater: (store: AuthProfileStore) => boolean }) => {
      const freshStore = structuredClone(store);
      lockParams.updater(freshStore);
      return freshStore;
    },
  );
}

export function mockLockedUpdatesForStore(store: AuthProfileStore): void {
  usageMocks.readFresh.mockReturnValue(store);
  storeMocks.loadAuthProfileStoreWithoutExternalProfiles.mockImplementation(() => store);
  storeMocks.updateAuthProfileStoreWithLock.mockImplementation(
    async (lockParams: { updater: (store: AuthProfileStore) => boolean }) => {
      const freshStore = structuredClone(store);
      lockParams.updater(freshStore);
      return freshStore;
    },
  );
}
