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
  if (overrides.ensureAuthProfileStore) {
    const spy = vi
      .spyOn(authStore, "ensureAuthProfileStore")
      .mockImplementation(overrides.ensureAuthProfileStore);
    restoreReaders.push(() => spy.mockRestore());
  }
  if (overrides.loadAuthProfileStoreForRuntime) {
    const spy = vi
      .spyOn(authStore, "loadAuthProfileStoreForRuntime")
      .mockImplementation(overrides.loadAuthProfileStoreForRuntime);
    restoreReaders.push(() => spy.mockRestore());
  }
}

export function resetCliAuthEpochTestDeps(): void {
  for (const restore of restoreReaders.splice(0).reverse()) {
    restore();
  }
}
