import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import * as oauthTest from "./oauth-test-utils.js";
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
  return createOAuthRefreshCredential({
    provider,
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 3_600_000,
    ...overrides,
  });
}
export function expired(
  overrides: Omit<
    Parameters<typeof oauthTest.createExpiredOauthStore>[0],
    "profileId" | "provider"
  > = {},
) {
  return oauthTest.createExpiredOauthStore({ profileId, provider, ...overrides });
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

export function useOAuthCoordinationFixture() {
  const mocks = getOAuthProviderRuntimeMocks();
  let env: ReturnType<typeof captureEnv>;
  let resolver: typeof import("./oauth.js").resolveApiKeyForProfile;
  let releaseRefresh: (() => void) | undefined;
  let settleWork: (() => void | Promise<void>) | undefined;
  const reset = () => {
    resetFileLockStateForTest();
    oauthTest.resetOAuthProviderRuntimeMocks(mocks);
    clearRuntimeAuthProfileStoreSnapshots();
  };
  beforeEach(async () => {
    fixture.work = new AsyncWorkScope();
    releaseRefresh = undefined;
    env = captureEnv(oauthTest.OAUTH_AGENT_ENV_KEYS);
    reset();
    fixture.root = await oauthTest.createOAuthTestTempRoot("openclaw-oauth-shard-");
    fixture.mainDir = await oauthTest.createOAuthMainAgentDir(fixture.root);
    ({ resolveApiKeyForProfile: resolver } = await import("./oauth.js"));
  });
  afterEach(async () => {
    releaseRefresh?.();
    await settleWork?.();
    settleWork = undefined;
    await fixture.work.drain();
    env.restore();
    reset();
    await oauthTest.removeOAuthTestTempRoot(fixture.root);
  });
  const fixture = {
    refresh: mocks.refreshProviderOAuthCredentialWithPluginMock,
    root: "",
    mainDir: "",
    work: new AsyncWorkScope(),
    settle(cleanup: () => void | Promise<void>) {
      settleWork = cleanup;
    },
    async agentDirectory(name: string) {
      const directory = path.join(fixture.root, "agents", name, "agent");
      await fs.mkdir(directory, { recursive: true });
      return directory;
    },
    resolve(agentDir: string | undefined, id = profileId) {
      assert.ok(agentDir, "expected a seeded agent directory");
      return fixture.work.track(() =>
        resolver({
          cfg: {},
          store: ensureAuthProfileStore(agentDir),
          profileId: id,
          agentDir,
        }),
      );
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
      releaseRefresh = finish.resolve;
      fixture.refresh.mockImplementation(async () => {
        started.resolve();
        await finish.promise;
        return credential();
      });
      return { started: started.promise, finishRefresh: finish.resolve };
    },
  };
  return fixture;
}
