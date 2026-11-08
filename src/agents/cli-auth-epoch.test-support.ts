import { vi } from "vitest";
import * as authStore from "./auth-profiles/store-runtime.js";
import * as credentials from "./cli-credentials.js";

type CliAuthEpochDeps = {
  readCodexCliCredentialsCached: typeof credentials.readCodexCliCredentialsCached;
  readGeminiCliCredentialsCached: typeof credentials.readGeminiCliCredentialsCached;
  ensureAuthProfileStore: typeof authStore.ensureAuthProfileStore;
  loadAuthProfileStoreForRuntime: typeof authStore.loadAuthProfileStoreForRuntime;
};

const restoreReaders: Array<() => void> = [];

export function setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void {
  if (overrides.readCodexCliCredentialsCached) {
    const spy = vi
      .spyOn(credentials, "readCodexCliCredentialsCached")
      .mockImplementation(overrides.readCodexCliCredentialsCached);
    restoreReaders.push(() => spy.mockRestore());
  }
  if (overrides.readGeminiCliCredentialsCached) {
    const spy = vi
      .spyOn(credentials, "readGeminiCliCredentialsCached")
      .mockImplementation(overrides.readGeminiCliCredentialsCached);
    restoreReaders.push(() => spy.mockRestore());
  }
  const ensureStore = overrides.ensureAuthProfileStore;
  if (ensureStore) {
    const spy = vi.spyOn(authStore, "ensureAuthProfileStore").mockImplementation(ensureStore);
    const asyncSpy = vi
      .spyOn(authStore, "ensureAuthProfileStoreAsync")
      .mockImplementation(async (...args) => ensureStore(...args));
    restoreReaders.push(() => {
      spy.mockRestore();
      asyncSpy.mockRestore();
    });
  }
  const loadStore = overrides.loadAuthProfileStoreForRuntime;
  if (loadStore) {
    const spy = vi
      .spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync")
      .mockImplementation(async (...args) => loadStore(...args));
    restoreReaders.push(() => spy.mockRestore());
  }
}

export function resetCliAuthEpochTestDeps(): void {
  for (const restore of restoreReaders.splice(0).toReversed()) {
    restore();
  }
}
