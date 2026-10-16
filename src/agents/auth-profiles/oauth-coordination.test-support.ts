import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

export const profileId = "openai:default";
export const provider = "openai";
export function oauth(
  prefix = "rotated",
  overrides: Partial<OAuthCredential> = {},
): OAuthCredential {
  return {
    type: "oauth",
    provider,
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 3_600_000,
    ...overrides,
  };
}
export function expired(
  overrides: Omit<Parameters<typeof createExpiredOauthStore>[0], "profileId" | "provider"> = {},
) {
  return createExpiredOauthStore({ profileId, provider, ...overrides });
}
export function expectTerminal(credential: AuthProfileCredential | undefined) {
  expect(credential?.type === "oauth" && isOAuthRefreshFence(credential)).toBe(true);
  expect(credential?.type === "oauth" && isPendingOAuthRefreshFence(credential)).toBe(false);
}
export function candidate(agentId: string, agentDir: string) {
  const databasePath = resolveAuthProfileDatabasePath(agentDir);
  return {
    configured: true,
    agentId,
    agentDir,
    databasePath,
    databaseIdentity: readDatabasePathIdentitySync(databasePath),
    env: process.env,
  };
}
export function read(agentDir: string | undefined, id = profileId) {
  assert.ok(agentDir, "expected a seeded agent directory");
  return loadPersistedAuthProfileStore(agentDir)?.profiles[id];
}

/** Shared lifecycle only; each suite retains its own provider and race scenarios. */
export function useOAuthCoordinationFixture() {
  const mocks = getOAuthProviderRuntimeMocks();
  const refresh = mocks.refreshProviderOAuthCredentialWithPluginMock;
  let root: string;
  let mainDir: string;
  let env: ReturnType<typeof captureEnv>;
  let resolver: typeof import("./oauth.js").resolveApiKeyForProfile;
  let settleWork: (() => Promise<void>) | undefined;
  const reset = () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks(mocks);
    clearRuntimeAuthProfileStoreSnapshots();
  };
  beforeEach(async () => {
    env = captureEnv(OAUTH_AGENT_ENV_KEYS);
    reset();
    root = await createOAuthTestTempRoot("openclaw-oauth-shard-");
    mainDir = await createOAuthMainAgentDir(root);
    ({ resolveApiKeyForProfile: resolver } = await import("./oauth.js"));
    const { resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js");
    resetOAuthRefreshQueuesForTest();
  });
  afterEach(async () => {
    await settleWork?.();
    settleWork = undefined;
    env.restore();
    reset();
    await removeOAuthTestTempRoot(root);
  });
  return {
    refresh,
    get root() {
      return root;
    },
    get mainDir() {
      return mainDir;
    },
    settle(work: () => Promise<void>) {
      settleWork = work;
    },
    async agentDirectory(name: string) {
      const directory = path.join(root, "agents", name, "agent");
      await fs.mkdir(directory, { recursive: true });
      return directory;
    },
    resolve(agentDir: string | undefined, id = profileId) {
      assert.ok(agentDir, "expected a seeded agent directory");
      return resolveApiKeyForProfileInTest(resolver, {
        store: ensureAuthProfileStore(agentDir),
        profileId: id,
        agentDir,
      });
    },
    reconnect(agentDir: string, credential: OAuthCredential, id = profileId) {
      return persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId: id, credential }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
    },
    blockRefresh(credential: () => OAuthCredential) {
      const started = createDeferredCore();
      const finish = createDeferredCore();
      refresh.mockImplementation(async () => {
        started.resolve();
        await finish.promise;
        return credential();
      });
      return { started: started.promise, finishRefresh: finish.resolve };
    },
  };
}
