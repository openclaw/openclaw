import "./external-auth.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import * as providerRuntime from "../../plugins/provider-runtime.runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  connectUserModelAccount,
  readSelectedUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { retainPersistedCredential } from "./credential-authority.test-support.js";
import { createOAuthRefreshCredential as createCredential } from "./credential-fixtures.test-support.js";
import * as externalCliSync from "./external-cli-sync.js";
import { createOAuthManager } from "./oauth-manager.js";
import {
  mockOAuthProviderOperations,
  type NativeOAuthProviderFixture,
} from "./oauth-native-provider.test-support.js";
import { isSettledOAuthRefreshFailure, OAuthManagerRefreshError } from "./oauth-refresh-failure.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import * as storeRuntime from "./store-runtime.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const { testing: externalAuthTesting } = await import("./external-auth.test-support.js");

function oauth(access: string, refresh: string, overrides: Partial<OAuthCredential> = {}) {
  return createCredential({ access, refresh, ...overrides });
}

function rotated(overrides: Partial<OAuthCredential> = {}) {
  return oauth("rotated-access", "rotated-refresh", {
    expires: Date.now() + 600_000,
    ...overrides,
  });
}

function expired(overrides: Partial<OAuthCredential> = {}) {
  return oauth("expired-access", "expired-refresh", { expires: 1, ...overrides });
}

function expectFailedFence(value: AuthProfileStore["profiles"][string] | undefined) {
  expect(
    value?.type === "oauth" && isOAuthRefreshFence(value) && !isPendingOAuthRefreshFence(value),
  ).toBe(true);
}

function connect(credential: OAuthCredential) {
  const owner = ensureProfileForEmail("alice@example.test");
  return {
    owner,
    ...connectUserModelAccount({ ownerProfileId: owner.id, credential, assertCurrent() {} }),
  };
}

function createTestManager(overrides: NativeOAuthProviderFixture) {
  mockOAuthProviderOperations(overrides);
  return createOAuthManager();
}

function saveCredential(profileId: string, credential: OAuthCredential, agentDir: string) {
  saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
    filterExternalAuthProfiles: false,
  });
}

const readStored = (agentDir: string) =>
  ensureAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false });

function resolve(
  manager: ReturnType<typeof createOAuthManager>,
  profileId: string,
  credential: OAuthCredential,
  agentDir: string,
  options: Partial<Parameters<typeof manager.resolveOAuthAccess>[0]> = {},
) {
  return manager.resolveOAuthAccess({
    store: options.store ?? readStored(agentDir),
    profileId,
    credential,
    agentDir,
    ...options,
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
  vi.spyOn(externalCliSync, "readExternalCliBootstrapCredential").mockReturnValue(null);
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  vi.restoreAllMocks();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const stateDir of tempDirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createOAuthManager", () => {
  it("persists manager-admitted Anthropic refresh through the built-in fallback", async () => {
    await withOAuthAgentDirs("oauth-manager-anthropic-", async ({ agentDir }) => {
      const profileId = "anthropic:default";
      const credential = oauth("stale-access", "stale-refresh", {
        provider: "anthropic",
        expires: Date.now() + 4 * 60_000,
      });
      saveCredential(profileId, credential, agentDir);
      vi.spyOn(
        providerRuntime,
        "resolveProviderOAuthRefreshCapabilityWithPlugin",
      ).mockResolvedValue({ status: "unhandled" });
      vi.spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin").mockResolvedValue({
        status: "unhandled",
      });
      vi.spyOn(providerRuntime, "formatProviderAuthProfileApiKeyWithPlugin").mockResolvedValue(
        undefined,
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            '{"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600}',
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );

      const result = await resolve(createOAuthManager(), profileId, credential, agentDir);

      expect(fetch).toHaveBeenCalledOnce();
      expect(result?.credential).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toMatchObject(
        result?.credential,
      );
    });
  });

  it("serializes personal refreshes without CLI bootstrap or shared copies", async () => {
    const provider = "xai";
    await withOAuthAgentDirs("oauth-manager-personal-", async ({ mainAgentDir, agentDir }) => {
      const cfg = {
        models: { providers: { [provider]: { auth: "oauth", baseUrl: "", models: [] } } },
      } satisfies OpenClawConfig;
      const credential = expired({ provider, accountId: "acct-personal" });
      const { authProfileId: profileId } = connect(credential);
      const refreshed = rotated({ provider, accountId: "acct-personal" });
      const refreshCredential = vi.fn(async () => refreshed);
      const readBootstrapCredential = vi
        .spyOn(externalCliSync, "readExternalCliBootstrapCredential")
        .mockImplementation(() => createCredential());
      const manager = createTestManager({
        buildApiKey: async (_provider, value, context) => {
          expect(context.cfg).toBe(cfg);
          return value.access;
        },
        refreshCredential,
      });
      const results = await Promise.all(
        [mainAgentDir, agentDir].map((targetAgentDir) =>
          resolve(manager, profileId, credential, targetAgentDir, {
            store: ensureAuthProfileStore(targetAgentDir, { profileId }),
            cfg,
          }),
        ),
      );

      expect(results.map((result) => result?.apiKey)).toEqual(["rotated-access", "rotated-access"]);
      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(readBootstrapCredential).not.toHaveBeenCalled();
      expect(readUserModelAuthProfile(profileId)?.credential).toMatchObject(refreshed);
      for (const targetAgentDir of [undefined, mainAgentDir, agentDir]) {
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(targetAgentDir).profiles[profileId],
        ).toBeUndefined();
      }
    });
  });

  it("does not overwrite a personal reconnect while a refresh is in flight", async () => {
    await withOAuthAgentDirs("oauth-manager-personal-reconnect-", async ({ agentDir }) => {
      const credential = expired({ accountId: "workspace" });
      const { owner, authProfileId: profileId } = connect(credential);
      const reconnected = oauth("reconnected-access", "reconnected-refresh", {
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
          return rotated();
        },
      });

      const resolved = await withPersonalAuthProfileStore(profileId, async (personalStore) => {
        await personalStore.read();
        const readPrepared = personalStore.readCurrentCredential;
        const result = await resolve(manager, profileId, credential, agentDir, {
          personalStore,
          store: ensureAuthProfileStore(agentDir, { profileId }),
        });
        expect(readPrepared).toThrow("Personal model account authority is unavailable");
        expect(personalStore.readCurrentCredential()).toEqual(reconnected);
        return result;
      });
      expect(resolved?.apiKey).toBe("reconnected-access");
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(reconnected);
    });
  });

  it("does not overlay external auth while checking main-store adoption", async () => {
    await withOAuthAgentDirs("oauth-manager-main-adopt-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai:oauth";
      const subCredential = expired({ accountId: "acct-main" });
      const mainCredential = oauth("expired-main-access", "main-refresh", {
        expires: Date.now() - 30_000,
        accountId: "acct-main",
      });
      saveCredential(profileId, subCredential, agentDir);
      saveCredential(profileId, mainCredential, mainAgentDir);
      const authority = retainPersistedCredential(mainAgentDir, profileId);
      externalAuthTesting.setResolveExternalAuthProfilesForTest(() => [
        {
          profileId,
          credential: oauth("external-fresh-access", "external-fresh-refresh", {
            expires: Date.now() + 60_000,
            accountId: "acct-main",
          }),
          persistence: "runtime-only",
        },
      ]);

      const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
        expect(credential.access).toBe("expired-main-access");
        const pending = authority.readCurrentCredential();
        expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
        return rotated({ accountId: "acct-main" });
      });
      const manager = createTestManager({ refreshCredential });

      const result = await resolve(manager, profileId, subCredential, agentDir);

      expect(authority.readCurrentCredential()).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
      expect(result).toMatchObject({
        apiKey: "rotated-access",
        credential: { access: "rotated-access", refresh: "rotated-refresh" },
      });
    });
  });

  it("adopts main-store OAuth when the local expiry is out of range", async () => {
    await withOAuthAgentDirs("oauth-manager-invalid-local-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai-codex:default";
      const localCredential = oauth("poisoned-local-access", "local-refresh", {
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      });
      const mainCredential = oauth("main-access", "main-refresh", {
        expires: Date.now() + 10 * 60_000,
      });
      saveCredential(profileId, mainCredential, mainAgentDir);

      const refreshCredential = vi.fn(async () => {
        throw new Error("should not refresh poisoned local credential");
      });
      const manager = createTestManager({ refreshCredential });

      const store: AuthProfileStore = { version: 1, profiles: { [profileId]: localCredential } };
      const result = await resolve(manager, profileId, localCredential, agentDir, { store });

      expect(refreshCredential).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        apiKey: "main-access",
        credential: { access: "main-access" },
      });
      expect(store.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "main-access",
        refresh: "main-refresh",
      });
    });
  });

  it.each([false, true])(
    "refreshes adopted external OAuth and redacts failures (reject=%s)",
    async (reject) => {
      await withOAuthAgentDirs("oauth-manager-refresh-", async ({ agentDir }) => {
        const profileId = "minimax-portal:default";
        const provider = "minimax-portal";
        const localCredential = createCredential({
          provider,
          expires: reject ? Date.now() + 60_000 : 1,
        });
        const secrets = [
          "external-attempt-access",
          "external-attempt-refresh",
          "external-attempt-id-token",
        ] as const;
        const external = oauth(secrets[0], secrets[1], {
          provider,
          ...(reject ? { idToken: secrets[2] } : {}),
          expires: Date.now() - 30_000,
        });
        const refreshed = rotated({ provider });
        saveCredential(profileId, localCredential, agentDir);
        vi.spyOn(externalCliSync, "readExternalCliBootstrapCredential").mockReturnValue(external);
        const manager = createTestManager({
          refreshCredential: vi.fn(async (credential) => {
            expect(credential.refresh).toBe(external.refresh);
            if (reject) {
              throw new Error(`refresh rejected ${secrets.join(" ")}`);
            }
            return refreshed;
          }),
        });
        const result = resolve(manager, profileId, localCredential, agentDir, {
          store: ensureAuthProfileStore(agentDir),
          forceRefresh: reject,
        });
        if (reject) {
          const caught: unknown = await result.catch((error: unknown) => error);
          if (!(caught instanceof OAuthManagerRefreshError)) {
            throw caught;
          }
          expect(caught.message).toContain("refresh rejected");
          for (const secret of secrets) {
            expect(caught.message).not.toContain(secret);
            expect(formatErrorMessage(caught.cause)).not.toContain(secret);
          }
        } else {
          await expect(result).resolves.toMatchObject({
            apiKey: refreshed.access,
            credential: refreshed,
          });
          expect(readStored(agentDir).profiles[profileId]).toMatchObject(refreshed);
        }
      });
    },
  );

  it("skips the refresh adapter when the credential has no refresh token", async () => {
    await withOAuthTempRoot("oauth-manager-no-refresh-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const credential = oauth("", "", { expires: Date.now() - 60_000 });
      saveCredential(profileId, credential, agentDir);
      const refreshCredential = vi.fn(async () => null);
      const manager = createTestManager({ refreshCredential });

      const result = await resolve(manager, profileId, credential, agentDir);

      expect(result).toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
    });
  });

  it.each(["unavailable", "outcome-unknown"] as const)(
    "preserves invalid_grant through %s cleanup without unsafe recovery",
    async (cleanupCode) => {
      await withOAuthTempRoot("oauth-manager-cleanup-errors-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const credential = expired({ accountId: "acct-123" });
        saveCredential(profileId, credential, agentDir);
        const initiatingError = Object.assign(new Error("provider rejected invalid_grant"), {
          oauthRefreshFailure: {
            errorType: "invalid_grant_error",
            reason: "invalid_grant",
            status: 401,
            summary: "provider rejected invalid_grant",
          },
        });
        const ownerReadError = new Error("Owner credential read failed");
        const recoveryReadError = new Error("Recovery credential reload failed");
        const ownerCleanupError = new SqliteWorkerError("Owner cleanup failed", cleanupCode);
        const readStore = vi.spyOn(
          storeRuntime,
          "loadAuthProfileStoreWithoutExternalProfilesAsync",
        );
        const updateStore = vi.spyOn(storeRuntime, "updateAuthProfileStoreWithLock");
        let readsBeforeFailure = 0;
        const manager = createTestManager({
          refreshCredential: vi.fn(async () => {
            // Arm faults after the real owner has persisted its pending refresh fence.
            readsBeforeFailure = readStore.mock.calls.length;
            readStore.mockRejectedValueOnce(ownerReadError).mockRejectedValue(recoveryReadError);
            updateStore.mockRejectedValue(ownerCleanupError);
            throw initiatingError;
          }),
        });

        const caught: unknown = await resolve(manager, profileId, credential, agentDir, {
          store: { version: 1, profiles: { [profileId]: credential } },
        }).catch((error: unknown) => error);
        if (cleanupCode === "outcome-unknown") {
          expect(caught).toBeInstanceOf(AggregateError);
          expect(caught).not.toBeInstanceOf(OAuthManagerRefreshError);
          expect(hasSqliteWorkerOutcomeUnknown(caught)).toBe(true);
          expect(isSettledOAuthRefreshFailure(caught)).toBe(false);
          if (!(caught instanceof AggregateError)) {
            throw caught;
          }
          expect(caught.errors).toEqual([initiatingError, ownerReadError, ownerCleanupError]);
          expect(caught.cause).toBe(initiatingError);
          expect(readStore).toHaveBeenCalledTimes(readsBeforeFailure + 1);
          return;
        }
        if (!(caught instanceof OAuthManagerRefreshError)) {
          throw caught;
        }
        expect(caught.message).toContain("provider rejected invalid_grant");
        expect(caught.message).not.toContain(ownerReadError.message);
        expect(caught).toMatchObject(initiatingError.oauthRefreshFailure);
        expect(caught.cause).toBeInstanceOf(AggregateError);
        expect(isSettledOAuthRefreshFailure(caught)).toBe(false);
        const aggregate = caught.cause as AggregateError;
        expect(aggregate.errors).toHaveLength(4);
        expect(aggregate.cause).toBe(aggregate.errors[0]);
        for (const [index, error] of [
          initiatingError,
          ownerReadError,
          ownerCleanupError,
          recoveryReadError,
        ].entries()) {
          expect(formatErrorMessage(aggregate.errors[index])).toContain(error.message);
        }
      });
    },
  );

  it("fails closed after an undefined refresh rejection and invalid main-store recovery", async () => {
    await withOAuthAgentDirs("oauth-manager-refresh-fail-closed-", async ({ agentDir }) => {
      const profileId = "openai:user@example.com";
      const managedCredential = expired({
        email: "user@example.com",
        accountId: "acct-123",
      });
      saveCredential(profileId, managedCredential, agentDir);
      const authority = retainPersistedCredential(agentDir, profileId);
      let refreshRejected = false;
      const recoveryError = new Error("OAuth main recovery validation failed");
      const readMain = storeRuntime.ensureAuthProfileStoreWithoutExternalProfilesAsync;
      vi.spyOn(
        storeRuntime,
        "ensureAuthProfileStoreWithoutExternalProfilesAsync",
      ).mockImplementation(async (selectedDir, options) => {
        if (refreshRejected && selectedDir === undefined) {
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
        return readMain(selectedDir, options);
      });
      const refreshCredential = vi.fn(() => {
        const pending = authority.readCurrentCredential();
        expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
        refreshRejected = true;
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
        return Promise.reject(undefined);
      });
      const manager = createTestManager({ refreshCredential });

      const resolution = resolve(manager, profileId, managedCredential, agentDir, {
        validateCredential: (credential) => {
          if (credential.access === "recovery-access") {
            throw recoveryError;
          }
        },
      });
      await expect(resolution).rejects.toBeInstanceOf(OAuthManagerRefreshError);
      await expect(resolution.catch(isSettledOAuthRefreshFailure)).resolves.toBe(false);
      await expect(resolution).rejects.toMatchObject({ cause: expect.any(AggregateError) });
      const fenced = readStored(agentDir).profiles[profileId];
      expect(fenced).toMatchObject({
        type: "oauth",
        provider: "openai",
        expires: 1,
        accountId: "acct-123",
        email: "user@example.com",
      });
      expectFailedFence(fenced);
      expect(authority.readCurrentCredential()).toEqual(fenced);
      for (const secret of [managedCredential.access, managedCredential.refresh]) {
        expect(JSON.stringify(fenced)).not.toContain(secret);
      }
    });
  });
});

describe("createOAuthManager credential validation", () => {
  it.each(["refresh result", "authoritative claim"] as const)(
    "validates %s before persistence",
    async (stage) => {
      await withOAuthAgentDirs("oauth-manager-claim-validator-", async ({ mainAgentDir }) => {
        const profileId = "openai:oauth";
        const claiming = stage === "authoritative claim";
        const original = expired(claiming ? { accountId: "expected-account" } : {});
        const replacement = oauth("replacement-access", "replacement-refresh", {
          expires: Date.now() - 30_000,
          accountId: "other-account",
        });
        saveCredential(profileId, original, mainAgentDir);
        let replaced = false;
        const manager = createTestManager({
          canRefreshCredential: async () => {
            if (claiming && !replaced) {
              replaced = true;
              saveCredential(profileId, replacement, mainAgentDir);
            }
            return true;
          },
          refreshCredential: async () =>
            rotated({ accountId: claiming ? "expected-account" : "wrong-account" }),
        });

        await expect(
          resolve(manager, profileId, original, mainAgentDir, {
            forceRefresh: true,
            validateCredential: (candidate) => {
              if (
                claiming
                  ? candidate.accountId !== "expected-account"
                  : candidate.accountId === "wrong-account"
              ) {
                throw new Error("credential owner mismatch");
              }
            },
          }),
        ).rejects.toThrow("credential owner mismatch");

        const stored = readStored(mainAgentDir).profiles[profileId];
        if (claiming) {
          expect(stored).toEqual(replacement);
        } else {
          expect(stored).not.toMatchObject({
            access: "rotated-access",
            accountId: "wrong-account",
          });
        }
      });
    },
  );
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

  it.each(["refresh", "recover", "reject cross-tenant"] as const)(
    "keeps Copilot tenant ownership during %s",
    async (mode) => {
      await withOAuthAgentDirs("oauth-manager-copilot-", async ({ agentDir }) => {
        const failure = mode !== "refresh";
        const sameTenant = mode === "recover";
        // Post-claim recovery requires positive identity; ordinary refresh does not.
        const identity = failure ? { accountId: "shared-account-fixture" } : {};
        const local = {
          ...credential("acme.ghe.com", "child-fixture", Date.now() - 60_000),
          ...identity,
        };
        const main = {
          ...credential(
            sameTenant ? "https://acme.ghe.com/" : "other.ghe.com",
            "main-fixture",
            failure ? local.expires - 60_000 : Date.now() + 600_000,
          ),
          ...identity,
        };
        const renewed = failure
          ? { ...main, access: "renewed-fixture", expires: MAX_DATE_TIMESTAMP_MS }
          : {
              ...local,
              access: "refreshed-fixture",
              refresh: "rotated-fixture",
              expires: MAX_DATE_TIMESTAMP_MS,
            };
        save(local, agentDir);
        save(main);
        const refreshCredential = vi.fn(async (input: OAuthCredential) => {
          expect(input).toEqual(local);
          if (failure) {
            save(renewed);
            throw new Error("simulated provider refresh failure");
          }
          return renewed;
        });
        const result = resolve(
          createTestManager({ refreshCredential }),
          profileId,
          local,
          agentDir,
        );
        if (!failure || sameTenant) {
          await expect(result).resolves.toMatchObject({ apiKey: renewed.access });
        } else {
          await expect(result).rejects.toThrow("OAuth token refresh failed");
        }
        expect(refreshCredential).toHaveBeenCalledTimes(1);
        expect(read()).toEqual(failure ? renewed : main);
        const stored = read(agentDir);
        if (!failure) {
          expect(stored).toEqual(renewed);
          return;
        }
        expectFailedFence(stored);
        expect(stored).toMatchObject({
          provider: local.provider,
          enterpriseUrl: local.enterpriseUrl,
          accountId: local.accountId,
        });
        expect(stored).toMatchObject({
          access: expect.not.stringContaining(local.access),
          refresh: expect.not.stringContaining(local.refresh),
        });
      });
    },
  );
});
