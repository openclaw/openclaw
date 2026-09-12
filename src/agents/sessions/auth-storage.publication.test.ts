import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearAuthProfileMigrationDiagnostics } from "../auth-profiles/legacy-source-diagnostic.js";
import {
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../auth-profiles/oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { writePersistedAuthProfileStoreRaw } from "../auth-profiles/sqlite.js";
import type { OAuthCredential } from "../auth-profiles/types.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, FileAuthStorageBackend } from "./auth-storage.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "test-oauth",
    access: "synthetic-access-a",
    refresh: "synthetic-refresh-a",
    expires: Date.now() + 600_000,
    ...overrides,
  };
}

async function createSqliteAuthRefreshFixture(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  const providerId = "test-oauth";
  const profileId = `${providerId}:default`;
  const initial = createCredential({ provider: providerId, expires: 1, accountId: "account-a" });
  const refreshed = createCredential({
    provider: providerId,
    access: "synthetic-refreshed-a",
    refresh: "synthetic-refresh-a",
    accountId: "account-a",
  });
  const replacement = createCredential({
    provider: providerId,
    access: "synthetic-account-b",
    refresh: "synthetic-refresh-b",
    accountId: "account-b",
  });
  writePersistedAuthProfileStoreRaw(
    {
      version: 1,
      profiles: {
        [profileId]: initial,
        "other:default": { type: "api_key", provider: "other", key: "synthetic-other-old" },
      },
    },
    agentDir,
  );
  const backend = new FileAuthStorageBackend(path.join(agentDir, "auth.json"));
  const storage = AuthStorage.fromStorage(backend);
  const peer = AuthStorage.forAgent(agentDir, {});
  const refreshToken = vi.fn(async () => refreshed);
  getAuthStorageOAuthProviderRegistry(storage).register({
    id: providerId,
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    refreshToken,
    getApiKey: (credential) => credential.access,
  });
  return { backend, storage, peer, providerId, profileId, refreshed, replacement, refreshToken };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAuthProfileMigrationDiagnostics();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
});

describe("AuthStorage OAuth publication", () => {
  it.each([
    { phase: "claim", actor: "same", change: "logout" },
    { phase: "claim", actor: "peer", change: "replace" },
    { phase: "settlement", actor: "peer", change: "logout" },
    { phase: "settlement", actor: "same", change: "replace" },
    { phase: "claim", actor: "same", change: "unrelated" },
    { phase: "settlement", actor: "peer", change: "unrelated" },
    { phase: "settlement", actor: "same", change: "unchanged" },
  ])(
    "preserves $actor facade $change after durable $phase and before publication",
    async ({ phase, actor, change }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "auth-refresh-publication-" },
        async (state) => {
          const agentDir = state.agentDir();
          const {
            backend,
            storage,
            peer,
            providerId,
            profileId,
            refreshed,
            replacement,
            refreshToken,
          } = await createSqliteAuthRefreshFixture(agentDir);
          let otherWhenRefreshStarted = storage.get("other");
          refreshToken.mockImplementation(async () => {
            otherWhenRefreshStarted = storage.get("other");
            return refreshed;
          });
          const mutate = actor === "same" ? storage : peer;
          const withLock = backend.withLock.bind(backend);
          let queued = false;
          backend.withLock = (fn) => {
            let wrote = false;
            const result = withLock((current) => {
              const update = fn(current);
              wrote = update.next !== undefined;
              return update;
            });
            if (!queued && wrote) {
              const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
              if (
                durable?.type === "oauth" &&
                (phase === "claim"
                  ? isPendingOAuthRefreshFence(durable)
                  : durable.access === refreshed.access)
              ) {
                queued = true;
                queueMicrotask(() => {
                  if (change === "logout") {
                    mutate.logout(providerId);
                  } else if (change === "replace") {
                    mutate.set(providerId, replacement);
                  } else if (change === "unrelated") {
                    mutate.set("other", { type: "api_key", key: "synthetic-other-new" });
                  }
                });
              }
            }
            return result;
          };

          const apiKey = await storage.getApiKey(providerId);
          expect(queued).toBe(true);
          const durable = loadPersistedAuthProfileStore(agentDir)?.profiles;
          if (change === "logout") {
            expect(apiKey).toBeUndefined();
            expect(storage.get(providerId)).toBeUndefined();
            expect(durable?.[profileId]).toBeUndefined();
          } else if (change === "replace") {
            expect(apiKey).toBe(replacement.access);
            expect(storage.get(providerId)).toEqual(replacement);
            expect(durable?.[profileId]).toEqual(replacement);
          } else {
            expect(apiKey).toBe(refreshed.access);
            expect(storage.get(providerId)).toEqual(refreshed);
            expect(durable?.[profileId]).toEqual(refreshed);
          }
          expect(refreshToken).toHaveBeenCalledTimes(
            phase === "claim" && (change === "logout" || change === "replace") ? 0 : 1,
          );
          const otherKey = change === "unrelated" ? "synthetic-other-new" : "synthetic-other-old";
          if (phase === "claim" && change === "unrelated") {
            expect(otherWhenRefreshStarted).toEqual({ type: "api_key", key: otherKey });
          }
          expect(storage.get("other")).toEqual({ type: "api_key", key: otherKey });
          expect(durable?.["other:default"]).toEqual({
            type: "api_key",
            provider: "other",
            key: otherKey,
          });
        },
      );
    },
  );

  it.each(["unchanged", "logout", "replace"])(
    "preserves %s state when an observer publishes a settled credential",
    async (change) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "auth-refresh-observer-publication-" },
        async (state) => {
          const agentDir = state.agentDir();
          const {
            backend,
            storage,
            peer,
            providerId,
            profileId,
            refreshed,
            replacement,
            refreshToken,
          } = await createSqliteAuthRefreshFixture(agentDir);
          peer.set(providerId, createOAuthRefreshFence({ profileId, credential: refreshed }));
          storage.reload();
          const withLock = backend.withLock.bind(backend);
          let settlementQueued = false;
          let changeQueued = false;
          backend.withLock = (fn) => {
            const result = withLock(fn);
            const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
            if (durable?.type === "oauth") {
              if (!settlementQueued && isPendingOAuthRefreshFence(durable)) {
                settlementQueued = true;
                queueMicrotask(() => peer.set(providerId, refreshed));
              } else if (!changeQueued && durable.access === refreshed.access) {
                changeQueued = true;
                queueMicrotask(() => {
                  if (change === "logout") {
                    peer.logout(providerId);
                  } else if (change === "replace") {
                    peer.set(providerId, replacement);
                  }
                });
              }
            }
            return result;
          };

          const apiKey = await storage.getApiKey(providerId);
          expect(settlementQueued).toBe(true);
          expect(changeQueued).toBe(true);
          expect(refreshToken).not.toHaveBeenCalled();
          const expected =
            change === "logout" ? undefined : change === "replace" ? replacement : refreshed;
          expect(apiKey).toBe(expected?.access);
          expect(storage.get(providerId)).toEqual(expected);
          expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(expected);
        },
      );
    },
  );

  it.each([false, true])(
    "settles claim custody when publication read fails (replacement: %s)",
    async (replace) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "auth-refresh-publication-read-failure-" },
        async (state) => {
          const agentDir = state.agentDir();
          const { backend, storage, peer, providerId, profileId, replacement, refreshToken } =
            await createSqliteAuthRefreshFixture(agentDir);
          const withLock = backend.withLock.bind(backend);
          const readError = new Error("synthetic publication read failure");
          let queued = false;
          let failNextRead = false;
          backend.withLock = (fn) => {
            if (failNextRead) {
              failNextRead = false;
              throw readError;
            }
            let wrote = false;
            const result = withLock((current) => {
              const update = fn(current);
              wrote = update.next !== undefined;
              return update;
            });
            if (!queued && wrote) {
              const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
              if (durable?.type === "oauth" && isPendingOAuthRefreshFence(durable)) {
                queued = true;
                queueMicrotask(() => {
                  if (replace) {
                    peer.set(providerId, replacement);
                  }
                  failNextRead = true;
                });
              }
            }
            return result;
          };

          const apiKey = await storage.getApiKey(providerId);
          expect(queued).toBe(true);
          expect(refreshToken).not.toHaveBeenCalled();
          expect(storage.drainErrors()).toContain(readError);
          const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
          if (replace) {
            expect(apiKey).toBe(replacement.access);
            expect(storage.get(providerId)).toEqual(replacement);
            expect(durable).toEqual(replacement);
          } else {
            expect(apiKey).toBeUndefined();
            expect(storage.get(providerId)).toBeUndefined();
            expect(durable?.type).toBe("oauth");
            if (durable?.type !== "oauth") {
              throw new Error("Expected the failed refresh to retain a terminal OAuth fence");
            }
            expect(isOAuthRefreshFence(durable)).toBe(true);
            expect(isPendingOAuthRefreshFence(durable)).toBe(false);
          }
        },
      );
    },
  );
});
