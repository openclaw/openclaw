import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import * as authProfileStoreRuntime from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

const { saveAuthProfileStore } = authProfileStoreRuntime;

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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => await run(tempRoot));
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

describe("OAuth refresh generation fence", () => {
  it.each([
    { name: "access changed", change: "access", expectedCalls: 0 },
    { name: "refresh changed", change: "refresh", expectedCalls: 1 },
    { name: "only expiry changed", change: "expires", expectedCalls: 1 },
  ] as const)(
    "checks authoritative $name before forced provider I/O",
    async ({ change, expectedCalls }) => {
      await withOAuthTempRoot("oauth-manager-force-authoritative-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const supplied = createCredential({
          access: "supplied-access",
          refresh: "supplied-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-123",
        });
        const live = createCredential({
          ...supplied,
          ...(change === "access" ? { access: "live-access" } : {}),
          ...(change === "refresh" ? { refresh: "live-refresh" } : {}),
          ...(change === "expires" ? { expires: supplied.expires + 600_000 } : {}),
        });
        const staleStore = { version: 1 as const, profiles: { [profileId]: supplied } };
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: live } }, agentDir, {
          filterExternalAuthProfiles: false,
        });
        const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
          expect(credential).toEqual(live);
          return createCredential({
            ...credential,
            access: "provider-rotated-access",
            refresh: "provider-rotated-refresh",
            expires: Date.now() + 600_000,
          });
        });
        const manager = createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });

        await expect(
          manager.resolveOAuthAccess({
            store: staleStore,
            profileId,
            credential: supplied,
            agentDir,
            forceRefresh: true,
          }),
        ).resolves.toMatchObject({
          apiKey: expectedCalls === 0 ? "live-access" : "provider-rotated-access",
        });
        expect(refreshCredential).toHaveBeenCalledTimes(expectedCalls);
      });
    },
  );
});
