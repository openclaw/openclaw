import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import {
  connectUserModelAccount,
  readSelectedUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createOAuthRefreshCredential as createCredential,
  oidcIdentity,
} from "./credential-fixtures.test-support.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { isSettledOAuthRefreshFailure, OAuthManagerRefreshError } from "./oauth-refresh-failure.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import * as authProfileStoreRuntime from "./store-runtime.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import { captureAuthProfileStorePersistenceSnapshot } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function retainPersistedCredential(agentDir: string, selectedProfileId: string) {
  const shared = openOpenClawStateDatabase();
  const { databasePath } = captureAuthProfileStorePersistenceSnapshot(agentDir).owner;
  const source = readDatabasePathIdentitySync(databasePath);
  const authority = captureAuthProfileCredentialAuthority(
    captureOpenClawStateWorkerContext({ path: shared.path }),
    { databasePath, identity: `${source.key}:${source.birthtime ?? ""}` },
    selectedProfileId,
  );
  authority.observe(loadPersistedAuthProfileStore(agentDir)?.profiles[selectedProfileId]);
  return authority;
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

function tokens(name: string, overrides: Partial<OAuthCredential> = {}) {
  return {
    ...tokenPair(name),
    expires: Date.now() + 600_000,
    ...overrides,
  };
}

function tokenPair(name: string) {
  return { access: `${name}-access`, refresh: `${name}-refresh` };
}

async function refreshFailure(result: Promise<unknown>) {
  await expect(result).rejects.toBeInstanceOf(OAuthManagerRefreshError);
  const error = await result.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(OAuthManagerRefreshError);
  if (!(error instanceof OAuthManagerRefreshError)) {
    throw error;
  }
  return error;
}

function expired(name: string, overrides: Partial<OAuthCredential> = {}) {
  return createCredential(tokens(name, { expires: Date.now() - 60_000, ...overrides }));
}

function fresh(name: string, overrides: Partial<OAuthCredential> = {}) {
  return createCredential(tokens(name, overrides));
}

function profileStore(profileId: string, credential: OAuthCredential): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: credential } };
}

function readCredential(agentDir?: string, profileId = "openai:oauth") {
  return ensureAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false })
    .profiles[profileId];
}

function resolveStored(
  manager: ReturnType<typeof createOAuthManager>,
  credential: OAuthCredential,
  agentDir: string,
  options: Partial<Parameters<typeof manager.resolveOAuthAccess>[0]> = {},
) {
  return manager.resolveOAuthAccess({
    store:
      options.store ??
      ensureAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false }),
    profileId: "openai:oauth",
    credential,
    agentDir,
    ...options,
  });
}

function saveCredential(profileId: string, credential: OAuthCredential, agentDir: string) {
  saveAuthProfileStore(profileStore(profileId, credential), agentDir, {
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
        return tokens("personal-rotated", { accountId: "acct-personal", ...metadata });
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
        ...tokenPair("personal-rotated"),
        ...metadata,
      });
      for (const targetAgentDir of [undefined, mainAgentDir, agentDir]) {
        expect(readCredential(targetAgentDir, profileId)).toBeUndefined();
      }
    });
  });

  it("personal reconnect wins over refresh", async () => {
    await withOAuthAgentDirs("oauth-manager-reconnect-", async ({ agentDir }) => {
      const owner = ensureProfileForEmail("alice@example.test");
      const credential = createCredential({ expires: Date.now() - 60_000, accountId: "workspace" });
      const { authProfileId: profileId } = connectUserModelAccount({
        ownerProfileId: owner.id,
        credential,
        assertCurrent() {},
      });
      const reconnected = fresh("reconnected", { accountId: "workspace" });
      const manager = createTestManager({
        refreshCredential: async () => {
          connectUserModelAccount({
            ownerProfileId: owner.id,
            credential: reconnected,
            replacement: readSelectedUserModelAccount(owner.id, reconnected.provider),
            assertCurrent() {},
          });
          return tokens("stale-refresh", { refresh: "stale-refresh-token" });
        },
      });

      const resolved = await withPersonalAuthProfileStore(profileId, async (personalStore) => {
        await personalStore.read();
        const readPrepared = personalStore.readCurrentCredential;
        const result = await manager.resolveOAuthAccess({
          personalStore,
          store: ensureAuthProfileStore(agentDir, { profileId }),
          profileId,
          credential,
          agentDir,
        });
        expect(readPrepared).toThrow("Personal model account authority is unavailable");
        expect(personalStore.readCurrentCredential()).toEqual(reconnected);
        return result;
      });
      expect(resolved?.apiKey).toBe("reconnected-access");
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(reconnected);
    });
  });

  it("main-store adoption excludes external auth", async () => {
    await withOAuthAgentDirs("oauth-manager-adopt-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai:oauth";
      const subCredential = expired("expired-sub", {
        refresh: "sub-refresh",
        accountId: "acct-main",
      });
      const mainCredential = expired("expired-main", {
        refresh: "main-refresh",
        expires: Date.now() - 30_000,
        accountId: "acct-main",
      });
      saveCredential(profileId, subCredential, agentDir);
      saveCredential(profileId, mainCredential, mainAgentDir);
      const authority = retainPersistedCredential(mainAgentDir, profileId);
      externalAuthTesting.setResolveExternalAuthProfilesForTest(() => [
        {
          profileId,
          credential: fresh("external-fresh", {
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
        return tokens("rotated-main", { accountId: "acct-main" });
      });
      const manager = createTestManager({ refreshCredential });
      const result = await resolveStored(manager, subCredential, agentDir);

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(authority.readCurrentCredential()).toMatchObject(tokenPair("rotated-main"));
      expect(result).toMatchObject({
        apiKey: "rotated-main-access",
        credential: tokenPair("rotated-main"),
      });
    });
  });

  it("invalid local expiry adopts main-store OAuth", async () => {
    await withOAuthAgentDirs("oauth-manager-expiry-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai-codex:default";
      const localCredential = expired("poisoned-local", {
        refresh: "local-refresh",
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      });
      const mainCredential = fresh("main");
      saveCredential(profileId, mainCredential, mainAgentDir);

      const refreshCredential = vi.fn(async () => {
        throw new Error("should not refresh poisoned local credential");
      });
      const manager = createTestManager({ refreshCredential });

      const store = profileStore(profileId, localCredential);
      const result = await resolveStored(manager, localCredential, agentDir, { store, profileId });

      expect(refreshCredential).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        apiKey: "main-access",
        credential: { access: "main-access" },
      });
      expect(store.profiles[profileId]).toMatchObject({
        type: "oauth",
        ...tokenPair("main"),
      });
    });
  });

  it("refresh uses adopted external OAuth", async () => {
    await withOAuthAgentDirs("oauth-manager-external-", async ({ agentDir }) => {
      const profileId = "minimax-portal:default";
      const localCredential = expired("stale-local", { provider: "minimax-portal" });
      saveCredential(profileId, localCredential, agentDir);

      const manager = createTestManager({
        refreshCredential: vi.fn(async (credential) => {
          expect(credential.refresh).toBe("external-refresh");
          return tokens("rotated");
        }),
        readBootstrapCredential: () =>
          expired("expired-external", {
            provider: "minimax-portal",
            refresh: "external-refresh",
            expires: Date.now() - 30_000,
          }),
      });

      const result = await resolveStored(manager, localCredential, agentDir, {
        store: ensureAuthProfileStore(agentDir),
        profileId,
      });

      expect(result).toMatchObject({
        apiKey: "rotated-access",
        credential: {
          provider: "minimax-portal",
          ...tokenPair("rotated"),
        },
      });
      expect(readCredential(agentDir, profileId)).toMatchObject({
        type: "oauth",
        provider: "minimax-portal",
        ...tokenPair("rotated"),
      });
    });
  });

  it("skips the refresh adapter when the credential has no refresh token", async () => {
    await withOAuthTempRoot("oauth-manager-no-refresh-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const credential = expired("", { access: "", refresh: "" });
      saveCredential(profileId, credential, agentDir);
      const refreshCredential = vi.fn(async () => null);
      const manager = createTestManager({ refreshCredential });
      const result = await resolveStored(manager, credential, agentDir);

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
      const original = expired("expired", identity);
      const relogged = fresh("relogged", differentIdentity);
      saveCredential(profileId, original, agentDir);

      const manager = createTestManager({
        refreshCredential: vi.fn(async () => {
          saveCredential(profileId, relogged, agentDir);
          return tokens("rotated", { expires: Date.now() + 60_000 });
        }),
      });

      await expect(resolveStored(manager, original, agentDir)).rejects.toThrow(
        "OAuth token refresh failed",
      );
      expect(readCredential(agentDir, profileId)).toMatchObject({
        type: "oauth",
        ...tokenPair("relogged"),
        ...differentIdentity,
      });
    });
  });

  it("keeps invalid_grant primary when owner cleanup and recovery reload both fail", async () => {
    await withOAuthTempRoot("oauth-manager-cleanup-errors-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const original = expired("expired", { accountId: "acct-123" });
      saveCredential(profileId, original, agentDir);
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

      const caught = await refreshFailure(
        resolveStored(manager, original, agentDir, {
          store: profileStore(profileId, original),
        }),
      );
      expect(caught.message).toContain("provider rejected invalid_grant");
      expect(caught.message).not.toContain("unreadable");
      expect(caught).toMatchObject({
        errorType: "invalid_grant_error",
        reason: "invalid_grant",
        status: 401,
        summary: "provider rejected invalid_grant",
      });
      expect(caught.cause).toBeInstanceOf(AggregateError);
      expect(isSettledOAuthRefreshFailure(caught)).toBe(false);
      const aggregate = caught.cause as AggregateError;
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(aggregate.errors.map(formatErrorMessage)).toEqual(
        [
          "provider rejected invalid_grant",
          "is unreadable",
          "file is not a database",
          "is unreadable",
        ].map((message) => expect.stringContaining(message)),
      );
    });
  });

  it("undefined rejection and invalid recovery fail closed", async () => {
    await withOAuthAgentDirs("oauth-manager-recovery-", async ({ agentDir }) => {
      const profileId = "openai:user@example.com";
      const managedCredential = expired("managed-expired", {
        refresh: "managed-refresh",
        email: "user@example.com",
        accountId: "acct-123",
      });
      saveCredential(profileId, managedCredential, agentDir);
      const authority = retainPersistedCredential(agentDir, profileId);
      let refreshRejected = false;
      const recoveryError = new Error("OAuth main recovery validation failed");
      const readMain = authProfileStoreRuntime.ensureAuthProfileStoreWithoutExternalProfilesAsync;
      const recoveryRead = vi
        .spyOn(authProfileStoreRuntime, "ensureAuthProfileStoreWithoutExternalProfilesAsync")
        .mockImplementation(async (selectedDir, options) => {
          if (refreshRejected && selectedDir === undefined) {
            return profileStore(profileId, {
              ...managedCredential,
              access: "recovery-access",
              expires: Date.now() + 600_000,
            });
          }
          return readMain(selectedDir, options);
        });
      const refreshCredential = vi.fn(() => {
        const pending = authority.readCurrentCredential();
        expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
        refreshRejected = true;
        // oxlint-disable-next-line prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
        return Promise.reject(undefined);
      });
      const manager = createTestManager({ refreshCredential });
      const resolution = resolveStored(manager, managedCredential, agentDir, {
        profileId,
        validateCredential: (credential) => {
          if (credential.access === "recovery-access") {
            throw recoveryError;
          }
        },
      });
      try {
        await expect(resolution).rejects.toBeInstanceOf(OAuthManagerRefreshError);
        await expect(resolution.catch(isSettledOAuthRefreshFailure)).resolves.toBe(false);
        await expect(resolution).rejects.toMatchObject({ cause: expect.any(AggregateError) });
      } finally {
        recoveryRead.mockRestore();
      }
      const fenced = readCredential(agentDir, profileId);
      expect(fenced).toMatchObject({
        type: "oauth",
        provider: "openai",
        expires: 1,
        accountId: "acct-123",
        email: "user@example.com",
        access: expect.stringMatching(
          /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:access:[a-f0-9]{64}$/,
        ),
        refresh: expect.stringMatching(
          /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:refresh:[a-f0-9]{64}$/,
        ),
      });
      expect(authority.readCurrentCredential()).toEqual(fenced);
      expect(JSON.stringify(fenced)).not.toContain("managed-expired-access");
      expect(JSON.stringify(fenced)).not.toContain("managed-refresh");
    });
  });

  it("redacts the external oauth credential attempted during refresh failures", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-redact-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "sub", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "minimax-portal:default";
      const localCredential = fresh("fresh-local", {
        provider: "minimax-portal",
        expires: Date.now() + 60_000,
      });
      const externalCredential = expired("external-attempt", {
        provider: "minimax-portal",
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

      const caught = await refreshFailure(
        resolveStored(manager, localCredential, agentDir, {
          store: ensureAuthProfileStore(agentDir),
          profileId,
          forceRefresh: true,
        }),
      );
      expect(caught.message).toContain("refresh rejected");
      for (const message of [caught.message, formatErrorMessage(caught.cause)]) {
        for (const secret of [
          externalCredential.access,
          externalCredential.refresh,
          externalCredential.idToken!,
        ]) {
          expect(message).not.toContain(secret);
        }
      }
    });
  });
});

describe("createOAuthManager credential validation", () => {
  it.each(["refreshed", "authoritative"] as const)(
    "validates the %s credential before persistence or refresh ownership",
    async (phase) => {
      await withOAuthAgentDirs("oauth-manager-validator-", async ({ mainAgentDir }) => {
        const profileId = "openai:oauth";
        const original = expired(
          "expired",
          phase === "authoritative" ? { accountId: "expected-account" } : {},
        );
        const replacement = expired("replacement", {
          expires: Date.now() - 30_000,
          accountId: "other-account",
        });
        saveCredential(profileId, original, mainAgentDir);
        let replaced = false;
        const manager = createTestManager({
          canRefreshCredential: async () => {
            if (phase === "authoritative" && !replaced) {
              replaced = true;
              saveCredential(profileId, replacement, mainAgentDir);
            }
            return true;
          },
          refreshCredential: async () =>
            phase === "authoritative"
              ? tokens("refreshed", { accountId: "expected-account" })
              : tokens("wrong-account", { accountId: "wrong-account" }),
        });

        await expect(
          resolveStored(manager, original, mainAgentDir, {
            forceRefresh: true,
            validateCredential: (candidate) => {
              if (
                phase === "authoritative"
                  ? candidate.accountId !== "expected-account"
                  : candidate.accountId === "wrong-account"
              ) {
                throw new Error("credential owner mismatch");
              }
            },
          }),
        ).rejects.toThrow("credential owner mismatch");

        const persisted = readCredential(mainAgentDir);
        if (phase === "authoritative") {
          expect(persisted).toEqual(replacement);
        } else {
          expect(persisted).not.toMatchObject({
            access: "wrong-account-access",
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
  function manager(
    refreshCredential: Parameters<typeof createOAuthManager>[0]["refreshCredential"],
  ) {
    return createTestManager({ refreshCredential });
  }

  it("logout preserves another tenant", async () => {
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

  it("refresh never mirrors to another tenant", async () => {
    await withOAuthAgentDirs("oauth-manager-copilot-", async ({ agentDir }) => {
      const local = credential("acme.ghe.com", "child-fixture", Date.now() - 60_000);
      const main = credential("other.ghe.com", "main-fixture", Date.now() + 600_000);
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
      const result = await resolveStored(manager(refresh), local, agentDir, { profileId });
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
        const result = resolveStored(manager(refresh), local, agentDir, { profileId });
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
