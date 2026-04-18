import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

// Cross-account-leak defense-in-depth: each adopt site in oauth.ts calls the
// shared identity copy gate before copying main-store credentials into the
// sub-agent store. Unit tests cover policy variants; this suite proves each
// production branch refuses a mismatched accountId.

function resolveApiKeyForProfileInTest(
  params: Omit<Parameters<typeof resolveApiKeyForProfile>[0], "cfg">,
) {
  return resolveApiKeyForProfile({ cfg: {}, ...params });
}

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }, { id: "anthropic" }],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    formatProviderAuthProfileApiKeyWithPluginMock() ?? params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
}));

vi.mock("../../infra/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../../plugin-sdk/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("./external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-cli-sync.js", () => ({
  areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
  hasUsableOAuthCredential: (credential: OAuthCredential | undefined, now = Date.now()) =>
    credential?.type === "oauth" &&
    credential.access.trim().length > 0 &&
    Number.isFinite(credential.expires) &&
    credential.expires - now > 5 * 60 * 1000,
  isSafeToUseExternalCliCredential: () => true,
  readExternalCliBootstrapCredential: () => null,
  readManagedExternalCliCredential: () => null,
  resolveExternalCliAuthProfiles: () => [],
  shouldBootstrapFromExternalCliCredential: () => false,
  shouldReplaceStoredOAuthCredential: (existing: unknown, incoming: unknown) =>
    existing !== incoming,
}));

function oauthCred(params: {
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}): OAuthCredential {
  return { type: "oauth", ...params };
}

function storeWith(profileId: string, cred: OAuthCredential): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: cred } };
}

describe("OAuth credential adoption is identity-gated", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let caseIndex = 0;
  let mainAgentDir = "";

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-adopt-identity-"));
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    caseIndex += 1;
    const caseRoot = path.join(tempRoot, `case-${caseIndex}`);
    process.env.OPENCLAW_STATE_DIR = caseRoot;
    mainAgentDir = path.join(caseRoot, "agents", "main", "agent");
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await fs.mkdir(mainAgentDir, { recursive: true });
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("adoptNewerMainOAuthCredential refuses to adopt across accountId mismatch (pre-refresh path)", async () => {
    // Scenario: sub-agent starts with a still-valid OAuth cred (so no
    // refresh is triggered), but main holds an even fresher cred for a
    // different account. The pre-refresh adopt must refuse.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const subExpiry = Date.now() + 10 * 60 * 1000;
    const mainFresher = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-prerefresh", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-own-access",
          refresh: "sub-own-refresh",
          expires: subExpiry,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: mainFresher,
          accountId: "acct-other",
        }),
      ),
      mainAgentDir,
    );

    const result = await resolveApiKeyForProfileInTest({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Sub-agent must keep using its own access token, not main's foreign one.
    expect(result?.apiKey).toBe("sub-own-access");

    // Sub-agent store must NOT have been overwritten with main's foreign cred.
    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "sub-own-access",
      accountId: "acct-sub",
    });
  });

  it("inside-the-lock main adoption refuses across accountId mismatch and proceeds to own refresh", async () => {
    // Scenario: sub-agent's cred is expired, enters refreshOAuthTokenWithLock.
    // Inside the lock, main holds FRESH creds for a DIFFERENT account. The
    // inside-lock adopt branch must refuse and fall through to the HTTP
    // refresh path using the sub-agent's own refresh token.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-insidelock", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale-access",
          refresh: "sub-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: freshExpiry,
          accountId: "acct-other",
        }),
      ),
      mainAgentDir,
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

    const result = await resolveApiKeyForProfileInTest({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Sub-agent performed its own refresh (mock fired once) and got its
    // own new token, not main's foreign one.
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main must still hold its foreign cred, untouched (mirror would also
    // refuse because of identity mismatch).
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-foreign-access",
      accountId: "acct-other",
    });
  });

  it("catch-block main-inherit refuses across accountId mismatch and surfaces the original error", async () => {
    // Scenario: sub-agent refresh throws a non-refresh_token_reused error.
    // Main has fresh creds for a DIFFERENT account. The catch-block
    // main-inherit fallback must refuse to adopt and let the original
    // error propagate (wrapped).
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-catch-refuse", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale",
          refresh: "sub-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: Date.now() - 60_000,
          accountId: "acct-other",
        }),
      ),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Simulate another process writing fresh creds to main for a
      // DIFFERENT account while our refresh is in flight, then our
      // refresh throws a generic upstream error.
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

    await expect(
      resolveApiKeyForProfileInTest({
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);

    // Sub-agent store must still have its own stale cred \u2014 no leak.
    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "sub-stale",
      accountId: "acct-sub",
    });
  });
});
