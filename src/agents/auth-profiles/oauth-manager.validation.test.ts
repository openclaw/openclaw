import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

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

const tempDirs: string[] = [];

async function withMainAgentDir(
  prefix: string,
  run: (mainAgentDir: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempRoot);
  const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
  await fs.mkdir(mainAgentDir, { recursive: true });
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: tempRoot,
      OPENCLAW_AGENT_DIR: mainAgentDir,
    },
    async () => await run(mainAgentDir),
  );
}

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createOAuthManager credential validation", () => {
  it("validates a refreshed credential before persisting it", async () => {
    await withMainAgentDir("oauth-manager-refresh-validator-", async (mainAgentDir) => {
      const profileId = "openai:oauth";
      const credential = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, mainAgentDir, {
        filterExternalAuthProfiles: false,
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, value) => value.access,
        canRefreshCredential: async () => true,
        refreshCredential: async () => ({
          access: "wrong-account-access",
          refresh: "wrong-account-refresh",
          expires: Date.now() + 600_000,
          accountId: "wrong-account",
        }),
        readBootstrapCredential: () => null,
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
    await withMainAgentDir("oauth-manager-claim-validator-", async (mainAgentDir) => {
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
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, mainAgentDir, {
        filterExternalAuthProfiles: false,
      });
      let replaced = false;
      const manager = createOAuthManager({
        buildApiKey: async (_provider, value) => value.access,
        canRefreshCredential: async () => {
          if (!replaced) {
            replaced = true;
            saveAuthProfileStore(
              { version: 1, profiles: { [profileId]: replacement } },
              mainAgentDir,
              { filterExternalAuthProfiles: false },
            );
          }
          return true;
        },
        refreshCredential: async () => ({
          access: "refreshed-access",
          refresh: "refreshed-refresh",
          expires: Date.now() + 600_000,
          accountId: "expected-account",
        }),
        readBootstrapCredential: () => null,
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
