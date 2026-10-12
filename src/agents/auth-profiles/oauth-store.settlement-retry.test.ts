import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createOAuthRefreshCredential as createCredential } from "./credential-fixtures.test-support.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { OAuthManagerRefreshError } from "./oauth-refresh-failure.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import { captureOAuthRefreshSettlement } from "./oauth-refresh-observation.js";
import { settleOAuthRefreshClaim } from "./oauth-store.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import * as authProfileStoreRuntime from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
  authProfileStoreRuntime;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requirePersistedAuthProfileStore(agentDir: string): AuthProfileStore {
  const store = loadPersistedAuthProfileStore(agentDir);
  if (store === null) {
    throw new Error("Expected the auth-profile fixture store to exist");
  }
  return store;
}
async function withOAuthTempRoot(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => await run(root));
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
});
describe("OAuth rotated-credential settlement retry", () => {
  it.each([false, true])(
    "settles a known-null owner write without repeating provider I/O (committed: $0)",
    async (commitBeforeNull) => {
      await withOAuthTempRoot("oauth-settlement-null-retry-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "xai:synthetic";
        const expired = createCredential({
          provider: "xai",
          access: "synthetic-old-access",
          refresh: "synthetic-old-refresh",
          expires: 1,
          accountId: "synthetic-account",
        });
        const refreshed = createCredential({
          provider: "xai",
          access: "synthetic-new-access",
          refresh: "synthetic-new-refresh",
          expires: Date.now() + 21_600_000,
          accountId: "synthetic-account",
        });
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
          filterExternalAuthProfiles: false,
        });

        const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
        let providerReturned = false;
        let settlementWrites = 0;
        const validateCredential = vi.fn((_candidate: OAuthCredential) => {});
        vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
          async (params) => {
            if (providerReturned && params.assertCurrent) {
              settlementWrites += 1;
              if (settlementWrites === 1) {
                if (commitBeforeNull) {
                  await originalUpdate(params);
                  return null;
                }
                params.assertCurrent();
                const draft = structuredClone(requirePersistedAuthProfileStore(agentDir));
                expect(params.updater(draft)).toBe(true);
                params.assertCurrent();
                return null;
              }
            }
            return await originalUpdate(params);
          },
        );
        const refreshCredential = vi.fn(async () => {
          providerReturned = true;
          return refreshed;
        });
        const buildApiKey = vi.fn(
          async (_provider: string, credential: OAuthCredential) => credential.access,
        );
        const manager = createOAuthManager({
          buildApiKey,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });

        await expect(
          manager.resolveOAuthAccess({
            store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
            profileId,
            credential: expired,
            agentDir,
            validateCredential,
          }),
        ).resolves.toMatchObject({ apiKey: refreshed.access, credential: refreshed });
        expect(settlementWrites).toBe(commitBeforeNull ? 1 : 2);
        expect(refreshCredential).toHaveBeenCalledOnce();
        expect(buildApiKey).toHaveBeenCalledOnce();
        expect(validateCredential).toHaveBeenCalledWith(refreshed);
        expect(requirePersistedAuthProfileStore(agentDir).profiles[profileId]).toMatchObject({
          access: refreshed.access,
          refresh: refreshed.refresh,
          accountId: refreshed.accountId,
        });
      });
    },
  );

  it.each([false, true])(
    "keeps fail-closed behavior after two known-null owner writes (terminal failure: $0)",
    async (terminalAlsoFails) => {
      await withOAuthTempRoot("oauth-settlement-two-null-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "xai:synthetic";
        const expired = createCredential({
          provider: "xai",
          access: "synthetic-old-access",
          refresh: "synthetic-old-refresh",
          expires: 1,
          accountId: "synthetic-account",
        });
        const refreshed = createCredential({
          provider: "xai",
          access: "synthetic-new-access",
          refresh: "synthetic-new-refresh",
          expires: Date.now() + 21_600_000,
          accountId: "synthetic-account",
        });
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
          filterExternalAuthProfiles: false,
        });

        const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
        let providerReturned = false;
        let settlementWrites = 0;
        let terminalWrites = 0;
        vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
          async (params) => {
            if (providerReturned && params.assertCurrent) {
              settlementWrites += 1;
              params.assertCurrent();
              const draft = structuredClone(requirePersistedAuthProfileStore(agentDir));
              expect(params.updater(draft)).toBe(true);
              params.assertCurrent();
              return null;
            }
            if (providerReturned && settlementWrites === 2) {
              terminalWrites += 1;
              if (terminalAlsoFails) {
                return null;
              }
            }
            return await originalUpdate(params);
          },
        );
        const refreshCredential = vi.fn(async () => {
          providerReturned = true;
          return refreshed;
        });
        const buildApiKey = vi.fn(
          async (_provider: string, credential: OAuthCredential) => credential.access,
        );
        const manager = createOAuthManager({
          buildApiKey,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });

        const caught = await manager
          .resolveOAuthAccess({
            store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
            profileId,
            credential: expired,
            agentDir,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(caught).toBeInstanceOf(OAuthManagerRefreshError);
        const cause = (caught as OAuthManagerRefreshError).cause;
        if (terminalAlsoFails) {
          expect(cause).toBeInstanceOf(AggregateError);
          const errors = (cause as AggregateError).errors.map(formatErrorMessage).join(" ");
          expect(errors).toContain("Failed to persist refreshed OAuth credential");
          expect(errors).toContain("Failed to persist terminal OAuth refresh fence");
        } else {
          expect(formatErrorMessage(cause)).toContain(
            "Failed to persist refreshed OAuth credential",
          );
        }
        expect(settlementWrites).toBe(2);
        expect(terminalWrites).toBe(1);
        expect(refreshCredential).toHaveBeenCalledOnce();
        expect(buildApiKey).not.toHaveBeenCalled();
        const persisted = requirePersistedAuthProfileStore(agentDir).profiles[profileId];
        expect(persisted?.type === "oauth" && isPendingOAuthRefreshFence(persisted)).toBe(
          terminalAlsoFails,
        );
        if (!terminalAlsoFails) {
          expect(persisted?.type === "oauth" ? persisted.access : "").toContain(":failed:access:");
        }
        expect(
          captureOAuthRefreshSettlement({
            databasePaths: [resolveAuthProfileDatabasePath(agentDir)],
            profileId,
            matchesProvider: (provider) => provider === "xai",
          }),
        ).toBeUndefined();
      });
    },
  );

  it("does not retry an unknown SQLite commit outcome or terminalize its fence", async () => {
    await withOAuthTempRoot("oauth-settlement-unknown-outcome-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "xai:synthetic";
      const expired = createCredential({
        provider: "xai",
        access: "synthetic-old-access",
        refresh: "synthetic-old-refresh",
        expires: 1,
        accountId: "synthetic-account",
      });
      const refreshed = createCredential({
        provider: "xai",
        access: "synthetic-new-access",
        refresh: "synthetic-new-refresh",
        expires: Date.now() + 21_600_000,
        accountId: "synthetic-account",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
      const unknownOutcome = new SqliteWorkerError(
        "synthetic SQLite commit outcome unknown",
        "outcome-unknown",
      );
      let providerReturned = false;
      let settlementWrites = 0;
      let terminalWrites = 0;
      vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
        async (params) => {
          if (providerReturned && params.assertCurrent) {
            settlementWrites += 1;
            await originalUpdate(params);
            throw unknownOutcome;
          }
          if (providerReturned) {
            terminalWrites += 1;
          }
          return await originalUpdate(params);
        },
      );
      const refreshCredential = vi.fn(async () => {
        providerReturned = true;
        return refreshed;
      });
      const buildApiKey = vi.fn(
        async (_provider: string, credential: OAuthCredential) => credential.access,
      );
      const manager = createOAuthManager({
        buildApiKey,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        }),
      ).rejects.toBe(unknownOutcome);
      expect(settlementWrites).toBe(1);
      expect(terminalWrites).toBe(0);
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(buildApiKey).not.toHaveBeenCalled();
      expect(requirePersistedAuthProfileStore(agentDir).profiles[profileId]).toMatchObject({
        access: refreshed.access,
        refresh: refreshed.refresh,
        accountId: refreshed.accountId,
      });
      expect(
        captureOAuthRefreshSettlement({
          databasePaths: [resolveAuthProfileDatabasePath(agentDir)],
          profileId,
          matchesProvider: (provider) => provider === "xai",
        }),
      ).toBeUndefined();
    });
  });

  it.each(["new-owner", "reconnect", "deleted-profile", "failed-fence"] as const)(
    "does not retry over a %s that wins after the first null",
    async (kind) => {
      await withOAuthTempRoot("oauth-settlement-owner-race-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "xai:synthetic";
        const expired = createCredential({
          provider: "xai",
          access: "synthetic-old-access",
          refresh: "synthetic-old-refresh",
          expires: 1,
          accountId: "synthetic-account",
        });
        const refreshed = createCredential({
          provider: "xai",
          access: "synthetic-new-access",
          refresh: "synthetic-new-refresh",
          expires: Date.now() + 21_600_000,
          accountId: "synthetic-account",
        });
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
          filterExternalAuthProfiles: false,
        });

        const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
        let providerReturned = false;
        let settlementWrites = 0;
        let terminalWrites = 0;
        let pendingFence: OAuthCredential | undefined;
        vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
          async (params) => {
            if (providerReturned && params.assertCurrent) {
              settlementWrites += 1;
              if (settlementWrites === 1) {
                params.assertCurrent();
                const draft = structuredClone(requirePersistedAuthProfileStore(agentDir));
                expect(params.updater(draft)).toBe(true);
                params.assertCurrent();
                if (kind === "deleted-profile") {
                  saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, {
                    filterExternalAuthProfiles: false,
                  });
                } else if (kind === "failed-fence") {
                  if (!pendingFence) {
                    throw new Error("Expected the pending OAuth claim before the injected race");
                  }
                  const failedFence = createFailedOAuthRefreshFence(pendingFence);
                  saveAuthProfileStore(
                    { version: 1, profiles: { [profileId]: failedFence } },
                    agentDir,
                    {
                      filterExternalAuthProfiles: false,
                    },
                  );
                } else {
                  const replacement = createCredential({
                    provider: "xai",
                    access:
                      kind === "new-owner"
                        ? "synthetic-owner-access"
                        : "synthetic-reconnect-access",
                    refresh:
                      kind === "new-owner"
                        ? "synthetic-owner-refresh"
                        : "synthetic-reconnect-refresh",
                    expires: Date.now() + 21_600_000,
                    accountId: kind === "new-owner" ? "synthetic-account" : "reconnected-account",
                  });
                  saveAuthProfileStore(
                    { version: 1, profiles: { [profileId]: replacement } },
                    agentDir,
                    {
                      filterExternalAuthProfiles: false,
                    },
                  );
                }
                clearRuntimeAuthProfileStoreSnapshots();
                return null;
              }
            }
            if (providerReturned && !params.assertCurrent) {
              terminalWrites += 1;
            }
            return await originalUpdate(params);
          },
        );
        const refreshCredential = vi.fn(async () => {
          const pending = requirePersistedAuthProfileStore(agentDir).profiles[profileId];
          if (pending?.type !== "oauth" || !isPendingOAuthRefreshFence(pending)) {
            throw new Error("Expected the provider call to observe its pending OAuth fence");
          }
          pendingFence = pending;
          providerReturned = true;
          return refreshed;
        });
        const buildApiKey = vi.fn(
          async (_provider: string, credential: OAuthCredential) => credential.access,
        );
        const manager = createOAuthManager({
          buildApiKey,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });
        const resolution = manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        });

        if (kind === "new-owner") {
          await expect(resolution).resolves.toMatchObject({
            apiKey: "synthetic-owner-access",
            credential: {
              access: "synthetic-owner-access",
              refresh: "synthetic-owner-refresh",
              accountId: "synthetic-account",
            },
          });
          expect(buildApiKey).toHaveBeenCalledOnce();
        } else {
          await expect(resolution).rejects.toBeInstanceOf(OAuthManagerRefreshError);
          expect(buildApiKey).not.toHaveBeenCalled();
        }
        expect(settlementWrites).toBe(1);
        expect(refreshCredential).toHaveBeenCalledOnce();
        if (kind === "deleted-profile") {
          expect(requirePersistedAuthProfileStore(agentDir).profiles[profileId]).toBeUndefined();
        } else if (kind === "failed-fence") {
          const persisted = requirePersistedAuthProfileStore(agentDir).profiles[profileId];
          expect(persisted?.type === "oauth" && isPendingOAuthRefreshFence(persisted)).toBe(false);
          expect(persisted?.type === "oauth" ? persisted.access : "").toContain(":failed:access:");
        } else {
          expect(requirePersistedAuthProfileStore(agentDir).profiles[profileId]).toMatchObject({
            access: kind === "new-owner" ? "synthetic-owner-access" : "synthetic-reconnect-access",
            refresh:
              kind === "new-owner" ? "synthetic-owner-refresh" : "synthetic-reconnect-refresh",
            accountId: kind === "new-owner" ? "synthetic-account" : "reconnected-account",
          });
        }
        expect(terminalWrites).toBe(kind === "new-owner" ? 0 : 1);
      });
    },
  );

  it("revalidates credential authority before the bounded retry", async () => {
    await withOAuthTempRoot("oauth-settlement-retry-validation-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "xai:synthetic";
      const expired = createCredential({
        provider: "xai",
        access: "synthetic-old-access",
        refresh: "synthetic-old-refresh",
        expires: 1,
        accountId: "synthetic-account",
      });
      const refreshed = createCredential({
        provider: "xai",
        access: "synthetic-new-access",
        refresh: "synthetic-new-refresh",
        expires: Date.now() + 21_600_000,
        accountId: "synthetic-account",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
      let providerReturned = false;
      let rejectAfterFirstNull = false;
      let settlementWrites = 0;
      let retryValidationCalls = 0;
      const validateCredential = vi.fn((candidate: OAuthCredential) => {
        if (rejectAfterFirstNull && candidate.access === refreshed.access) {
          retryValidationCalls += 1;
          throw new Error("synthetic credential authority changed before retry");
        }
      });
      vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
        async (params) => {
          if (providerReturned && params.assertCurrent) {
            settlementWrites += 1;
            if (settlementWrites === 1) {
              params.assertCurrent();
              const draft = structuredClone(requirePersistedAuthProfileStore(agentDir));
              expect(params.updater(draft)).toBe(true);
              params.assertCurrent();
              rejectAfterFirstNull = true;
              return null;
            }
          }
          return await originalUpdate(params);
        },
      );
      const refreshCredential = vi.fn(async () => {
        providerReturned = true;
        return refreshed;
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      const caught = await manager
        .resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
          validateCredential,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(caught).toBeInstanceOf(OAuthManagerRefreshError);
      expect(retryValidationCalls).toBeGreaterThan(0);
      expect(settlementWrites).toBe(2);
      expect(refreshCredential).toHaveBeenCalledOnce();
      const persisted = requirePersistedAuthProfileStore(agentDir).profiles[profileId];
      expect(persisted?.type === "oauth" ? persisted.access : "").not.toBe(refreshed.access);
      expect(persisted?.type === "oauth" && isPendingOAuthRefreshFence(persisted)).toBe(false);
    });
  });

  it("keeps the personal auth-profile store update path unchanged", async () => {
    const profileId = "openai:personal-synthetic";
    const expired = createCredential({
      access: "synthetic-personal-old-access",
      refresh: "synthetic-personal-old-refresh",
      expires: 1,
      accountId: "synthetic-personal-account",
    });
    const fence = createOAuthRefreshFence({ profileId, credential: expired });
    const refreshed = createCredential({
      access: "synthetic-personal-new-access",
      refresh: "synthetic-personal-new-refresh",
      expires: Date.now() + 21_600_000,
      accountId: "synthetic-personal-account",
    });
    let state: AuthProfileStore = { version: 1, profiles: { [profileId]: fence } };
    const update = vi.fn(
      async (
        updater: (store: AuthProfileStore) => boolean,
        assertCurrent?: () => void,
      ): Promise<AuthProfileStore> => {
        assertCurrent?.();
        const draft = structuredClone(state);
        if (updater(draft)) {
          assertCurrent?.();
          state = draft;
        }
        return structuredClone(state);
      },
    );
    const personalStore = {
      databasePath: "/synthetic/personal-auth-profiles.db",
      read: async () => structuredClone(state),
      update,
      accept: async (credential: OAuthCredential) => credential,
    };
    const mainStoreUpdate = vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock");

    await expect(
      settleOAuthRefreshClaim({
        personalStore,
        profileId,
        generation: expired,
        fence,
        refreshed,
      }),
    ).resolves.toEqual({ credential: refreshed, persisted: true });
    expect(update).toHaveBeenCalledOnce();
    expect(mainStoreUpdate).not.toHaveBeenCalled();
    expect(state.profiles[profileId]).toEqual(refreshed);
  });
});
