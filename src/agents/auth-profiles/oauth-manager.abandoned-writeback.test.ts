/**
 * Regression: an in-lock OAuth critical section abandoned by its deadline must
 * not persist or mirror credentials after the global refresh lock is released,
 * because a successor refresher may already own the key.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { OAuthCredential, OAuthCredentials } from "./types.js";

// Shrink the in-lock deadline so a real-timer test can observe an abandoned
// critical section. The network-call timeout stays larger so the SECTION
// deadline (not the inner call timeout) is what abandons the running body.
vi.mock("./constants.js", async () => {
  const actual = await vi.importActual<typeof import("./constants.js")>("./constants.js");
  return {
    ...actual,
    OAUTH_REFRESH_INLOCK_TIMEOUT_MS: 150,
    OAUTH_REFRESH_CALL_TIMEOUT_MS: 5_000,
  };
});

const tempDirs: string[] = [];

async function withOAuthAgentDirs(
  prefix: string,
  run: (dirs: { mainAgentDir: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempRoot);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => {
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("abandoned in-lock OAuth refresh write-back", () => {
  it("does not persist or mirror a refresh that completes after the section deadline", async () => {
    await withOAuthAgentDirs("oauth-manager-abandoned-writeback-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const staleCredential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: staleCredential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      // The refresh call outlives the (shrunken) in-lock deadline, then
      // completes with rotated tokens only after the section was abandoned.
      let resolveRefresh: ((value: OAuthCredentials) => void) | undefined;
      const refreshCredential = vi.fn(
        () =>
          new Promise<OAuthCredentials>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        refreshCredential,
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: staleCredential,
          agentDir,
        }),
      ).rejects.toBeInstanceOf(OAuthManagerRefreshError);
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      // Let the abandoned continuation settle with rotated credentials; the
      // ownership guard must discard the write-back instead of persisting it.
      resolveRefresh?.({
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      clearRuntimeAuthProfileStoreSnapshots();
      const subStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(subStore.profiles[profileId]).toMatchObject({
        access: "expired-access",
        refresh: "expired-refresh",
      });
      const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
        allowKeychainPrompt: false,
      });
      expect(mainStore.profiles[profileId]).toBeUndefined();
    });
  });
});
