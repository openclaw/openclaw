import fs from "node:fs/promises";
import { vi } from "vitest";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createOAuthRefreshCredential as createCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { writePersistedAuthProfileStoreRaw } from "../auth-profiles/sqlite.js";
import * as authProfileSqlite from "../auth-profiles/sqlite.js";
import * as authProfileStoreUpdate from "../auth-profiles/store-update.js";
import type { AuthProfileStore, OAuthCredential } from "../auth-profiles/types.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, type AuthStorageBackend } from "./auth-storage.js";

export const stored = (agentDir: string, profileId: string) =>
  loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];

export function withAgent(
  action: (agentDir: string, state: OpenClawTestState) => Promise<void>,
  agentId = "main",
) {
  return withOpenClawTestState({ layout: "state-only", prefix: "auth-refresh-" }, async (state) => {
    const agentDir = state.agentDir(agentId);
    await fs.mkdir(agentDir, { recursive: true });
    await action(agentDir, state);
  });
}

export function profileStore(
  credential: OAuthCredential,
  profileId = `${credential.provider}:default`,
  extra: AuthProfileStore["profiles"] = {},
) {
  return { version: 1, profiles: { ...extra, [profileId]: credential } };
}

export function oauthProvider(
  id: string,
  refreshToken: OAuthProviderInterface["refreshToken"],
): OAuthProviderInterface {
  return {
    id,
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    refreshToken,
    getApiKey: (credential) => credential.access,
  };
}

export function observeAuthTransactions(after: () => void, before?: () => void) {
  const runTransaction = authProfileSqlite.runAuthProfileWriteTransaction;
  vi.spyOn(authProfileSqlite, "runAuthProfileWriteTransaction").mockImplementation(
    (agentDir, operation, options) => {
      before?.();
      const result = runTransaction(agentDir, operation, options);
      after();
      return result;
    },
  );
  const runUpdate = authProfileStoreUpdate.runAuthProfileStoreUpdate;
  vi.spyOn(authProfileStoreUpdate, "runAuthProfileStoreUpdate").mockImplementation(
    async (params) => {
      before?.();
      await runUpdate(params);
      after();
    },
  );
}

function createPublicationCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return createCredential({
    provider: "test-oauth",
    access: "synthetic-access-a",
    refresh: "synthetic-refresh-a",
    expires: Date.now() + 600_000,
    accountId: "account-a",
    ...overrides,
  });
}

export async function createSqliteAuthRefreshFixture(agentDir: string) {
  const providerId = "test-oauth";
  const profileId = `${providerId}:default`;
  const initial = createPublicationCredential({ expires: 1 });
  const refreshed = createPublicationCredential({
    access: "synthetic-refreshed-a",
  });
  const replacement = createPublicationCredential({
    access: "synthetic-account-b",
    refresh: "synthetic-refresh-b",
    accountId: "account-b",
  });
  writePersistedAuthProfileStoreRaw(
    profileStore(initial, profileId, {
      "other:default": { type: "api_key", provider: "other", key: "synthetic-other-old" },
    }),
    agentDir,
  );
  const storage = AuthStorage.forAgent(agentDir, {});
  const peer = AuthStorage.forAgent(agentDir, {});
  const refreshToken = vi.fn(async () => refreshed);
  getAuthStorageOAuthProviderRegistry(storage).register(oauthProvider(providerId, refreshToken));
  return { storage, peer, providerId, profileId, refreshed, replacement, refreshToken };
}

export function serializedBackend(
  initial: OAuthCredential,
  hooks: { before?: () => void; after?: () => void } = {},
  profileId = initial.provider,
) {
  let persisted = JSON.stringify({ [profileId]: initial });
  const set = (credential: OAuthCredential) => {
    persisted = JSON.stringify({ [profileId]: credential });
  };
  const backend: AuthStorageBackend = {
    withLock: (fn) => {
      hooks.before?.();
      try {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      } finally {
        hooks.after?.();
      }
    },
    async withLockAsync() {
      throw new Error("refresh must not use withLockAsync");
    },
  };
  return { backend, read: () => persisted, set };
}
