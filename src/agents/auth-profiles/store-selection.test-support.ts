import { vi } from "vitest";

type SelectionStoreFixture = { profiles: Record<string, unknown> };

export function createAuthProfileStoreRuntimeMock<T extends SelectionStoreFixture>(
  readStore: () => T,
) {
  return {
    ensureAuthProfileStore: readStore,
    prepareAuthProfileProviderForSelection: async ({ profileId }: { profileId: string }) => ({
      profileId,
      provider: (readStore().profiles[profileId] as { provider?: string } | undefined)?.provider,
    }),
    ensureAuthProfileStoreWithoutExternalProfiles: readStore,
    ensureAuthProfileStoreForLocalUpdate: readStore,
    loadAuthProfileStore: readStore,
    loadAuthProfileStoreForRuntime: readStore,
    loadAuthProfileStoreForSecretsRuntime: readStore,
    loadAuthProfileStoreWithoutExternalProfiles: readStore,
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async ({ update }) => update(readStore())),
  };
}

export async function createAuthProfileStoreSelectionMock<T extends SelectionStoreFixture>(
  readStore: () => T,
) {
  // Keep native bootstrap exports while reads follow each test's current store.
  const actual = await vi.importActual<typeof import("./store.js")>("./store.js");
  return {
    ...actual,
    getRuntimeAuthProfileStoreSnapshot: readStore,
    findPersistedAuthProfileCredential: ({ profileId }: { profileId: string }) =>
      readStore().profiles[profileId],
    resolveAuthProfileProviderForSelection: ({ profileId }: { profileId: string }) =>
      (readStore().profiles[profileId] as { provider?: string } | undefined)?.provider,
  };
}
