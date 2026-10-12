/**
 * Tests OAuth manager store and refresh behavior.
 * Covers identity safety, main-store adoption, refresh persistence, fallback
 * recovery, and external profile overlays.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  connectUserModelAccount,
  readSelectedUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { oidcIdentity } from "./credential-fixtures.test-support.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { isSettledOAuthRefreshFailure, OAuthManagerRefreshError } from "./oauth-refresh-failure.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import * as authProfileStoreRuntime from "./store-runtime.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

function createTestManager(overrides: Partial<Parameters<typeof createOAuthManager>[0]>) {
  return createOAuthManager({
    buildApiKey: async (_provider, credential) => credential.access,
    canRefreshCredential: async () => true,
    refreshCredential: async () => null,
    readBootstrapCredential: () => null,
    ...overrides,
  });
}

function saveCredential(profileId: string, credential: OAuthCredential, agentDir: string) {
  saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
    filterExternalAuthProfiles: false,
  });
}

const tempDirs: string[] = [];

async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempRoot);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => await run(tempRoot));
}

async function withOAuthAgentDirs(
  prefix: string,
  run: (dirs: { mainAgentDir: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  await withOAuthTempRoot(prefix, async (tempRoot) => {
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    await withEnvAsync({ OPENCLAW_AGENT_DIR: mainAgentDir }, async () => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(mainAgentDir, { recursive: true });
      await run({ mainAgentDir, agentDir });
    });
  });
}

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const stateDir of tempDirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createOAuthManager", () => {
  it("serializes personal refreshes without CLI bootstrap or shared copies", async () => {
    const provider = "xai";
    const metadata = {
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/authorize",
      issuer: "https://auth.x.ai",
      authFlow: "device-code",
    };
    await withOAuthAgentDirs("oauth-manager-personal-", async ({ mainAgentDir, agentDir }) => {
      const cfg = {
        models: { providers: { [provider]: { auth: "oauth", baseUrl: "", models: [] } } },
      } satisfies OpenClawConfig;
      const owner = ensureProfileForEmail("alice@example.test");
      const credential = createCredential({
        provider,
        ...metadata,
        expires: Date.now() - 60_000,
        accountId: "acct-personal",
      });
      const { authProfileId: profileId } = connectUserModelAccount({
        ownerProfileId: owner.id,
        credential,
        assertCurrent() {},
      });
      const refreshCredential = vi.fn(async (current: OAuthCredential) => {
        expect(current).toEqual(credential);
        return {
          access: "personal-rotated-access",
          refresh: "personal-rotated-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-personal",
          ...metadata,
        };
      });
      const readBootstrapCredential = vi.fn(() => createCredential());
      const manager = createTestManager({
        buildApiKey: async (_provider, value, context) => {
          expect(context.cfg).toBe(cfg);
          return value.access;
        },
        refreshCredential,
        readBootstrapCredential,
      });
      const results = await Promise.all(
        [mainAgentDir, agentDir].map((targetAgentDir) =>
          manager.resolveOAuthAccess({
            store: ensureAuthProfileStore(targetAgentDir, { profileId }),
            profileId,
            credential,
            agentDir: targetAgentDir,
            cfg,
          }),
        ),
      );

      expect(results.map((result) => result?.apiKey)).toEqual([
        "personal-rotated-access",
        "personal-rotated-access",
      ]);
      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(readBootstrapCredential).not.toHaveBeenCalled();
      expect(readUserModelAuthProfile(profileId)?.credential).toMatchObject({
        access: "personal-rotated-access",
        refresh: "personal-rotated-refresh",
        ...metadata,
      });
      for (const targetAgentDir of [undefined, mainAgentDir, agentDir]) {
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(targetAgentDir).profiles[profileId],
        ).toBeUndefined();
      }
    });
  });

  it("does not overwrite a personal reconnect while a refresh is in flight", async () => {
    await withOAuthAgentDirs("oauth-manager-personal-reconnect-", async ({ agentDir }) => {
      const owner = ensureProfileForEmail("alice@example.test");
      const credential = createCredential({ expires: Date.now() - 60_000, accountId: "workspace" });
      const { authProfileId: profileId } = connectUserModelAccount({
        ownerProfileId: owner.id,
        credential,
        assertCurrent() {},
      });
      const reconnected = createCredential({
        access: "reconnected-access",
        refresh: "reconnected-refresh",
        expires: Date.now() + 600_000,
        accountId: "workspace",
      });
      const manager = createTestManager({
        refreshCredential: async () => {
          connectUserModelAccount({
            ownerProfileId: owner.id,
            credential: reconnected,
            replacement: readSelectedUserModelAccount(owner.id, reconnected.provider),
            assertCurrent() {},
          });
          return {
            access: "stale-refresh-access",
            refresh: "stale-refresh-token",
            expires: Date.now() + 600_000,
          };
        },
      });

      const resolved = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStore(agentDir, { profileId }),
        profileId,
        credential,
        agentDir,
      });
      expect(resolved?.apiKey).toBe("reconnected-access");
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(reconnected);
    });
  });

  it("does not overlay external auth while checking main-store adoption", async () => {
    await withOAuthAgentDirs("oauth-manager-main-adopt-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai:oauth";
      const subCredential = createCredential({
        access: "expired-sub-access",
        refresh: "sub-refresh",
        expires: Date.now() - 60_000,
        accountId: "acct-main",
      });
      const mainCredential = createCredential({
        access: "expired-main-access",
        refresh: "main-refresh",
        expires: Date.now() - 30_000,
        accountId: "acct-main",
      });
      saveCredential(profileId, subCredential, agentDir);
      saveCredential(profileId, mainCredential, mainAgentDir);
      externalAuthTesting.setResolveExternalAuthProfilesForTest(() => [
        {
          profileId,
          credential: createCredential({
            access: "external-fresh-access",
            refresh: "external-fresh-refresh",
            expires: Date.now() + 60_000,
            accountId: "acct-main",
          }),
          persistence: "runtime-only",
        },
      ]);

      const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
        expect(credential.access).toBe("expired-main-access");
        return {
          access: "rotated-main-access",
          refresh: "rotated-main-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-main",
        };
      });
      const manager = createTestManager({
        refreshCredential,
      });

      const result = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential: subCredential,
        agentDir,
      });

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      if (!result) {
        throw new Error("Expected refreshed main-store OAuth result");
      }
      expect(result.apiKey).toBe("rotated-main-access");
      expect(result.credential.access).toBe("rotated-main-access");
      expect(result.credential.refresh).toBe("rotated-main-refresh");
    });
  });

  it("adopts main-store OAuth when the local expiry is out of range", async () => {
    await withOAuthAgentDirs("oauth-manager-invalid-local-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai-codex:default";
      const localCredential = createCredential({
        access: "poisoned-local-access",
        refresh: "local-refresh",
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      });
      const mainCredential = createCredential({
        access: "main-access",
        refresh: "main-refresh",
        expires: Date.now() + 10 * 60_000,
      });
      saveCredential(profileId, mainCredential, mainAgentDir);

      const refreshCredential = vi.fn(async () => {
        throw new Error("should not refresh poisoned local credential");
      });
      const manager = createTestManager({
        refreshCredential,
      });

      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          [profileId]: localCredential,
        },
      };
      const result = await manager.resolveOAuthAccess({
        store,
        profileId,
        credential: localCredential,
        agentDir,
      });

      expect(refreshCredential).not.toHaveBeenCalled();
      expect(result?.apiKey).toBe("main-access");
      expect(result?.credential.access).toBe("main-access");
      expect(store.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "main-access",
        refresh: "main-refresh",
      });
    });
  });

  it("refreshes with the adopted external oauth credential", async () => {
    await withOAuthAgentDirs("oauth-manager-refresh-", async ({ agentDir }) => {
      const profileId = "minimax-portal:default";
      const localCredential = createCredential({
        provider: "minimax-portal",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      saveCredential(profileId, localCredential, agentDir);

      const manager = createTestManager({
        refreshCredential: vi.fn(async (credential) => {
          expect(credential.refresh).toBe("external-refresh");
          return {
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 600_000,
          };
        }),
        readBootstrapCredential: () =>
          createCredential({
            provider: "minimax-portal",
            access: "expired-external-access",
            refresh: "external-refresh",
            expires: Date.now() - 30_000,
          }),
      });

      const result = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        credential: localCredential,
        agentDir,
      });

      if (!result) {
        throw new Error("Expected refreshed external OAuth result");
      }
      expect(result.apiKey).toBe("rotated-access");
      expect(result.credential.provider).toBe("minimax-portal");
      expect(result.credential.access).toBe("rotated-access");
      expect(result.credential.refresh).toBe("rotated-refresh");
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
      ).toMatchObject({
        type: "oauth",
        provider: "minimax-portal",
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
    });
  });

  it("skips the refresh adapter when the credential has no refresh token", async () => {
    await withOAuthTempRoot("oauth-manager-no-refresh-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const credential = createCredential({
        access: "",
        refresh: "",
        expires: Date.now() - 60_000,
      });
      saveCredential(profileId, credential, agentDir);
      const refreshCredential = vi.fn(async () => null);
      const manager = createTestManager({
        refreshCredential,
      });

      const result = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential,
        agentDir,
      });

      expect(result).toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
    });
  });

  it("rejects changed OIDC identity after CAS", async () => {
    const identity = oidcIdentity();
    const differentIdentity = oidcIdentity({ sub: "subject-b" });
    await withOAuthTempRoot("oauth-manager-cas-different-identity-", async (tempRoot) => {
      const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
      const agentDir = path.join(tempRoot, "agents", "sub", "agent");
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        ...identity,
      });
      const relogged = createCredential({
        access: "relogged-access",
        refresh: "relogged-refresh",
        expires: Date.now() + 10 * 60_000,
        ...differentIdentity,
      });
      saveCredential(profileId, expired, agentDir);

      const manager = createTestManager({
        refreshCredential: vi.fn(async () => {
          saveCredential(profileId, relogged, agentDir);
          return {
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 60_000,
          };
        }),
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: expired,
          agentDir,
        }),
      ).rejects.toThrow("OAuth token refresh failed");
      const persisted = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(persisted.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "relogged-access",
        refresh: "relogged-refresh",
        ...differentIdentity,
      });
    });
  });

  it("keeps invalid_grant primary when owner cleanup and recovery reload both fail", async () => {
    await withOAuthTempRoot("oauth-manager-cleanup-errors-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        accountId: "acct-123",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const initiatingError = Object.assign(new Error("provider rejected invalid_grant"), {
        oauthRefreshFailure: {
          errorType: "invalid_grant_error",
          reason: "invalid_grant",
          status: 401,
          summary: "provider rejected invalid_grant",
        },
      });
      const manager = createTestManager({
        refreshCredential: vi.fn(async () => {
          clearRuntimeAuthProfileStoreSnapshots();
          await closeOpenClawAgentDatabasesAsync(tempRoot);
          closeOpenClawAgentDatabasesForTest(tempRoot);
          await fs.writeFile(resolveAuthProfileDatabasePath(agentDir), "not a sqlite database");
          throw initiatingError;
        }),
      });

      try {
        await manager.resolveOAuthAccess({
          store: { version: 1, profiles: { [profileId]: expired } },
          profileId,
          credential: expired,
          agentDir,
        });
        throw new Error("Expected refresh failure");
      } catch (caught) {
        if (!(caught instanceof OAuthManagerRefreshError)) {
          throw caught;
        }
        expect(caught.message).toContain("provider rejected invalid_grant");
        expect(caught.message).not.toContain("unreadable");
        expect(caught.errorType).toBe("invalid_grant_error");
        expect(caught.reason).toBe("invalid_grant");
        expect(caught.status).toBe(401);
        expect(caught.summary).toBe("provider rejected invalid_grant");
        expect(caught.cause).toBeInstanceOf(AggregateError);
        expect(isSettledOAuthRefreshFailure(caught)).toBe(false);
        const aggregate = caught.cause as AggregateError;
        expect(aggregate.errors).toHaveLength(4);
        expect(aggregate.cause).toBe(aggregate.errors[0]);
        expect(formatErrorMessage(aggregate.errors[0])).toContain(
          "provider rejected invalid_grant",
        );
        expect(formatErrorMessage(aggregate.errors[1])).toContain("is unreadable");
        expect(formatErrorMessage(aggregate.errors[2])).toContain("file is not a database");
        expect(formatErrorMessage(aggregate.errors[3])).toContain("is unreadable");
      }
    });
  });

  it.each(["settled", "main validation"] as const)(
    "fails closed after an undefined managed refresh rejection (%s)",
    async (recovery) => {
      await withOAuthAgentDirs("oauth-manager-refresh-fail-closed-", async ({ agentDir }) => {
        const profileId = "openai:user@example.com";
        const managedCredential = createCredential({
          access: "managed-expired-access",
          refresh: "managed-refresh",
          expires: Date.now() - 60_000,
          email: "user@example.com",
          accountId: "acct-123",
        });
        saveCredential(profileId, managedCredential, agentDir);
        let refreshRejected = false;
        const recoveryError = new Error(`OAuth main recovery ${recovery} failed`);
        const readMain = authProfileStoreRuntime.ensureAuthProfileStoreWithoutExternalProfilesAsync;
        const recoveryRead = vi
          .spyOn(authProfileStoreRuntime, "ensureAuthProfileStoreWithoutExternalProfilesAsync")
          .mockImplementation(async (selectedDir, options) => {
            if (refreshRejected && selectedDir === undefined) {
              if (recovery === "main validation") {
                return {
                  version: 1,
                  profiles: {
                    [profileId]: {
                      ...managedCredential,
                      access: "recovery-access",
                      expires: Date.now() + 600_000,
                    },
                  },
                };
              }
            }
            return readMain(selectedDir, options);
          });
        const refreshCredential = vi.fn(() => {
          refreshRejected = true;
          // oxlint-disable-next-line prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
          return Promise.reject(undefined);
        });
        const manager = createTestManager({
          refreshCredential,
        });

        const resolution = manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: managedCredential,
          agentDir,
          validateCredential: (credential) => {
            if (credential.access === "recovery-access") {
              throw recoveryError;
            }
          },
        });
        try {
          await expect(resolution).rejects.toBeInstanceOf(OAuthManagerRefreshError);
          await expect(resolution.catch(isSettledOAuthRefreshFailure)).resolves.toBe(
            recovery === "settled",
          );
          if (recovery !== "settled") {
            await expect(resolution).rejects.toMatchObject({ cause: expect.any(AggregateError) });
          }
        } finally {
          recoveryRead.mockRestore();
        }
        const fenced = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }).profiles[profileId];
        expect(fenced).toMatchObject({
          type: "oauth",
          provider: "openai",
          expires: 1,
          accountId: "acct-123",
          email: "user@example.com",
        });
        if (fenced?.type !== "oauth") {
          throw new Error("expected durable OAuth refresh fence");
        }
        expect(fenced.access).toMatch(
          /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:access:[a-f0-9]{64}$/,
        );
        expect(fenced.refresh).toMatch(
          /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:refresh:[a-f0-9]{64}$/,
        );
        expect(JSON.stringify(fenced)).not.toContain("managed-expired-access");
        expect(JSON.stringify(fenced)).not.toContain("managed-refresh");
        if (recovery === "settled") {
          await expect(
            manager.resolveOAuthAccess({
              store: { version: 1, profiles: { [profileId]: fenced } },
              credential: fenced,
              profileId,
              agentDir,
            }),
          ).resolves.toBeNull();
          expect(refreshCredential).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it("redacts the external oauth credential attempted during refresh failures", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-redact-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "sub", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "minimax-portal:default";
      const localCredential = createCredential({
        provider: "minimax-portal",
        access: "fresh-local-access",
        refresh: "fresh-local-refresh",
        expires: Date.now() + 60_000,
      });
      const externalCredential = createCredential({
        provider: "minimax-portal",
        access: "external-attempt-access",
        refresh: "external-attempt-refresh",
        idToken: "external-attempt-id-token",
        expires: Date.now() - 30_000,
      });
      saveCredential(profileId, localCredential, agentDir);

      const manager = createTestManager({
        refreshCredential: vi.fn(async () => {
          throw new Error(
            "refresh rejected external-attempt-access external-attempt-refresh external-attempt-id-token",
          );
        }),
        readBootstrapCredential: () => externalCredential,
      });

      try {
        await manager.resolveOAuthAccess({
          store: ensureAuthProfileStore(agentDir),
          profileId,
          credential: localCredential,
          agentDir,
          forceRefresh: true,
        });
        throw new Error("Expected refresh failure");
      } catch (caught) {
        if (!(caught instanceof OAuthManagerRefreshError)) {
          throw caught;
        }
        expect(caught.message).toContain("refresh rejected");
        expect(caught.message).not.toContain("external-attempt-access");
        expect(caught.message).not.toContain("external-attempt-refresh");
        expect(caught.message).not.toContain("external-attempt-id-token");
        const surfacedCauseMessage = formatErrorMessage(caught.cause);
        expect(surfacedCauseMessage).not.toContain("external-attempt-access");
        expect(surfacedCauseMessage).not.toContain("external-attempt-refresh");
        expect(surfacedCauseMessage).not.toContain("external-attempt-id-token");
      }
    });
  });
});

describe("createOAuthManager credential validation", () => {
  it("validates a refreshed credential before persisting it", async () => {
    await withOAuthAgentDirs("oauth-manager-refresh-validator-", async ({ mainAgentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      });
      saveCredential(profileId, credential, mainAgentDir);
      const manager = createTestManager({
        refreshCredential: async () => ({
          access: "wrong-account-access",
          refresh: "wrong-account-refresh",
          expires: Date.now() + 600_000,
          accountId: "wrong-account",
        }),
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(mainAgentDir),
          profileId,
          credential,
          agentDir: mainAgentDir,
          forceRefresh: true,
          validateCredential: (candidate) => {
            if (candidate.accountId === "wrong-account") {
              throw new Error("credential owner mismatch");
            }
          },
        }),
      ).rejects.toThrow("credential owner mismatch");

      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[profileId],
      ).not.toMatchObject({
        access: "wrong-account-access",
        accountId: "wrong-account",
      });
    });
  });

  it("validates the authoritative credential before claiming refresh ownership", async () => {
    await withOAuthAgentDirs("oauth-manager-claim-validator-", async ({ mainAgentDir }) => {
      const profileId = "openai:oauth";
      const original = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        accountId: "expected-account",
      });
      const replacement = createCredential({
        access: "replacement-access",
        refresh: "replacement-refresh",
        expires: Date.now() - 30_000,
        accountId: "other-account",
      });
      saveCredential(profileId, original, mainAgentDir);
      let replaced = false;
      const manager = createTestManager({
        canRefreshCredential: async () => {
          if (!replaced) {
            replaced = true;
            saveCredential(profileId, replacement, mainAgentDir);
          }
          return true;
        },
        refreshCredential: async () => ({
          access: "refreshed-access",
          refresh: "refreshed-refresh",
          expires: Date.now() + 600_000,
          accountId: "expected-account",
        }),
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(mainAgentDir),
          profileId,
          credential: original,
          agentDir: mainAgentDir,
          forceRefresh: true,
          validateCredential: (candidate) => {
            if (candidate.accountId !== "expected-account") {
              throw new Error("credential owner mismatch");
            }
          },
        }),
      ).rejects.toThrow("credential owner mismatch");

      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[profileId],
      ).toEqual(replacement);
    });
  });
});

describe("Copilot tenant boundaries", () => {
  const profileId = "github-copilot:default";
  const credential = (enterpriseUrl: string, access: string, expires: number): OAuthCredential => ({
    type: "oauth",
    provider: "github-copilot",
    enterpriseUrl,
    access,
    refresh: access,
    expires,
  });

  function save(cred: OAuthCredential, agentDir?: string) {
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: cred } }, agentDir);
  }
  function read(agentDir?: string) {
    return loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
  }
  function manager(
    refreshCredential: Parameters<typeof createOAuthManager>[0]["refreshCredential"],
  ) {
    return createTestManager({ refreshCredential });
  }

  it("logout removes only stores that own the selected identity-less credential", async () => {
    await withOAuthAgentDirs("oauth-manager-copilot-", async ({ agentDir }) => {
      const main = credential("other.ghe.com", "main-fixture", MAX_DATE_TIMESTAMP_MS);
      save(credential("acme.ghe.com", "child-fixture", MAX_DATE_TIMESTAMP_MS), agentDir);
      save(main);
      expect(await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [profileId] })).toBe(
        true,
      );
      expect(read(agentDir)).toBeUndefined();
      expect(read()).toEqual(main);
    });
  });

  it("resolves a newer main credential only for a compatible tenant upgrade", async () => {
    await withOAuthAgentDirs("oauth-manager-copilot-", async ({ agentDir }) => {
      const local = credential("acme.ghe.com", "child-fixture", Date.now() + 10 * 60_000);
      const main = {
        ...credential("https://acme.ghe.com/", "main-fixture", MAX_DATE_TIMESTAMP_MS),
        accountId: "main-fixture-account",
      };
      save(local, agentDir);
      save(main);
      const refresh = vi.fn(async () => null);
      const result = await manager(refresh).resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential: local,
        agentDir,
      });
      expect(result?.apiKey).toBe(main.access);
      expect(refresh).not.toHaveBeenCalled();
      expect(read(agentDir)).toEqual(local);
      expect(read()).toEqual(main);
    });
  });

  it("persists local refresh without mirroring to another tenant", async () => {
    const mainDomain = "other.ghe.com";
    await withOAuthAgentDirs("oauth-manager-copilot-", async ({ agentDir }) => {
      const local = credential("acme.ghe.com", "child-fixture", Date.now() - 60_000);
      const main = credential(mainDomain, "main-fixture", Date.now() + 600_000);
      const refreshed = {
        ...local,
        access: "refreshed-fixture",
        refresh: "rotated-fixture",
        expires: MAX_DATE_TIMESTAMP_MS,
      };
      save(local, agentDir);
      save(main);
      const refresh = vi.fn(async (input: OAuthCredential) => {
        expect(input).toEqual(local);
        return refreshed;
      });
      const result = await manager(refresh).resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential: local,
        agentDir,
      });
      expect(result?.apiKey).toBe(refreshed.access);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(read(agentDir)).toEqual(refreshed);
      expect(read()).toEqual(main);
    });
  });

  it.each([
    ["other.ghe.com", false],
    ["https://acme.ghe.com/", true],
  ] as const)(
    "recovers failed refresh only within the same tenant (%s)",
    async (mainDomain, sameTenant) => {
      await withOAuthAgentDirs("oauth-manager-copilot-", async ({ agentDir }) => {
        // Post-claim recovery requires positive identity, independently of tenant scope.
        const local = {
          ...credential("acme.ghe.com", "child-fixture", Date.now() - 60_000),
          accountId: "shared-account-fixture",
        };
        const main = {
          ...credential(mainDomain, "main-fixture", local.expires - 60_000),
          accountId: "shared-account-fixture",
        };
        const renewed = { ...main, access: "renewed-fixture", expires: MAX_DATE_TIMESTAMP_MS };
        save(local, agentDir);
        save(main);
        const refresh = vi.fn(async () => {
          save(renewed);
          throw new Error("simulated provider refresh failure");
        });
        const result = manager(refresh).resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: local,
          agentDir,
        });
        if (sameTenant) {
          await expect(result).resolves.toMatchObject({ apiKey: renewed.access });
        } else {
          await expect(result).rejects.toThrow("OAuth token refresh failed");
        }
        expect(refresh).toHaveBeenCalledTimes(1);
        const failed = read(agentDir);
        expect(failed?.type).toBe("oauth");
        if (failed?.type !== "oauth") {
          throw new Error("expected durable failed OAuth refresh fence");
        }
        expect(isOAuthRefreshFence(failed)).toBe(true);
        expect(isPendingOAuthRefreshFence(failed)).toBe(false);
        expect(failed).toMatchObject({
          provider: local.provider,
          enterpriseUrl: local.enterpriseUrl,
          accountId: local.accountId,
        });
        expect(failed.access).not.toContain(local.access);
        expect(failed.refresh).not.toContain(local.refresh);
        expect(read()).toEqual(renewed);
      });
    },
  );
});
