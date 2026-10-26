import "./mutation-lineage.js";
import type { AuthProfileStore } from "./types.js";

type RuntimeSnapshotsTestApi = {
  MAX_PERSISTED_MUTATION_OWNERS: number;
  MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER: number;
  getPersistedMutationRecordCounts(): { owners: number; profiles: number };
  resetPersistedMutationLineage(): void;
};

function getTestApi(): RuntimeSnapshotsTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.runtimeAuthSnapshotsTestApi")
  ] as RuntimeSnapshotsTestApi;
}

export const testing: RuntimeSnapshotsTestApi = {
  get MAX_PERSISTED_MUTATION_OWNERS() {
    return getTestApi().MAX_PERSISTED_MUTATION_OWNERS;
  },
  get MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER() {
    return getTestApi().MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER;
  },
  getPersistedMutationRecordCounts: () => getTestApi().getPersistedMutationRecordCounts(),
  resetPersistedMutationLineage: () => getTestApi().resetPersistedMutationLineage(),
};

export function createSnapshotStore(access: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 60_000,
        accountId: "acct-1",
      },
    },
    order: {
      openai: ["openai:default"],
    },
    usageStats: {
      "openai:default": {
        lastUsed: 1,
      },
    },
  };
}
