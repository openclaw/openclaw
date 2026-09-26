import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { oauthCred } from "./credential-fixtures.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import "./oauth-file-lock-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
  storeWith,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { resetOAuthRefreshQueuesForTest } from "./oauth.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

function expectPersistedOpenAICodexProfile(
  credential: AuthProfileStore["profiles"][string],
  metadata: Record<string, unknown> = {},
): void {
  expect(credential).toMatchObject({ type: "oauth", provider: "openai", ...metadata });
}

// Exercise the identity gate at pre-refresh, locked refresh, and failure recovery boundaries.

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }, { id: "anthropic" }],
}));

describe("OAuth credential adoption is identity-gated", () => {
  const profileId = "openai:default";
  const provider = "openai";
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let caseIndex = 0;
  let mainAgentDir = "";

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-adopt-identity-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
    caseIndex += 1;
    const caseRoot = path.join(tempRoot, `case-${caseIndex}`);
    mainAgentDir = await createOAuthMainAgentDir(caseRoot);
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  async function seedStores(
    name: string,
    subCredential: Pick<OAuthCredential, "access" | "refresh" | "expires">,
    mainExpires: number,
  ): Promise<string> {
    const subAgentDir = path.join(tempRoot, "agents", name, "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(profileId, oauthCred({ provider, accountId: "acct-sub", ...subCredential })),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: mainExpires,
          accountId: "acct-other",
        }),
      ),
      mainAgentDir,
    );
    return subAgentDir;
  }

  function resolveFromSubAgent(subAgentDir: string) {
    return resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
  }

  it("adoptNewerMainOAuthCredential refuses to adopt across accountId mismatch (pre-refresh path)", async () => {
    const subExpiry = Date.now() + 10 * 60 * 1000;
    const mainFresher = Date.now() + 60 * 60 * 1000;

    const subAgentDir = await seedStores(
      "sub-prerefresh",
      { access: "sub-own-access", refresh: "sub-own-refresh", expires: subExpiry },
      mainFresher,
    );

    const result = await resolveFromSubAgent(subAgentDir);

    expect(result?.apiKey).toBe("sub-own-access");

    const subRaw = readAuthProfileStoreForTest(subAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(subRaw.profiles[profileId], "subRaw.profiles[profileId] test invariant"),
      {
        access: "sub-own-access",
        refresh: "sub-own-refresh",
        accountId: "acct-sub",
        expires: subExpiry,
      },
    );
    expect(JSON.stringify(subRaw)).not.toContain("main-foreign-access");
  });

  it("inside-the-lock main adoption refuses across accountId mismatch and proceeds to own refresh", async () => {
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = await seedStores(
      "sub-insidelock",
      { access: "sub-stale-access", refresh: "sub-refresh-token", expires: Date.now() - 60_000 },
      freshExpiry,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-sub",
        }) as never,
    );

    const result = await resolveFromSubAgent(subAgentDir);

    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("sub-refreshed-access");

    const mainRaw = readAuthProfileStoreForTest(mainAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(mainRaw.profiles[profileId], "mainRaw.profiles[profileId] test invariant"),
      {
        access: "main-foreign-access",
        refresh: "main-foreign-refresh",
        accountId: "acct-other",
        expires: freshExpiry,
      },
    );
  });

  it("catch-block main-inherit refuses across accountId mismatch and surfaces the original error", async () => {
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = await seedStores(
      "sub-catch-refuse",
      { access: "sub-stale", refresh: "sub-refresh-token", expires: Date.now() - 60_000 },
      Date.now() - 60_000,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // A concurrent login changes main while the sub-agent refresh is in flight.
      saveAuthProfileStore(
        storeWith(
          profileId,
          oauthCred({
            provider,
            access: "main-foreign-refreshed",
            refresh: "main-foreign-refresh-new",
            expires: freshExpiry,
            accountId: "acct-other",
          }),
        ),
        mainAgentDir,
      );
      throw new Error("upstream 503 service unavailable");
    });

    await expect(resolveFromSubAgent(subAgentDir)).rejects.toThrow(
      /OAuth token refresh failed for openai/,
    );

    // The failed owner stays fenced, preserving identity without leaking main.
    const subRaw = readAuthProfileStoreForTest(subAgentDir);
    const fenced = expectDefined(
      subRaw.profiles[profileId],
      "subRaw.profiles[profileId] test invariant",
    );
    expectPersistedOpenAICodexProfile(fenced, { accountId: "acct-sub" });
    expect(fenced.type === "oauth" ? fenced.access : "").toMatch(
      /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:access:[a-f0-9]{64}$/,
    );
    expect(fenced.type === "oauth" ? fenced.refresh : "").toMatch(
      /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:refresh:[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(subRaw)).not.toContain("main-foreign-refreshed");
  });
});
