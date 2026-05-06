import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { __testing as externalAuthTesting } from "./external-auth.js";
import {
  createOAuthManager,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  OAuthManagerRefreshError,
} from "./oauth-manager.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "./store.js";
import * as storeModule from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

const tempDirs: string[] = [];
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]);

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  envSnapshot.restore();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("isSafeToOverwriteStoredOAuthIdentity", () => {
  it("accepts matching account identities", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({ access: "rotated-access", accountId: "acct-123" }),
      ),
    ).toBe(true);
  });

  it("refuses overwriting an existing identity-less credential with a different token", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({}),
        createCredential({ access: "rotated-access", accountId: "acct-123" }),
      ),
    ).toBe(false);
  });

  it("refuses non-overlapping identity evidence", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({ access: "rotated-access", email: "user@example.com" }),
      ),
    ).toBe(false);
  });

  it("still allows identity-less external bootstrap adoption", () => {
    const existing = createCredential({
      access: "expired-local-access",
      refresh: "expired-local-refresh",
      expires: Date.now() - 60_000,
    });
    const incoming = createCredential({
      access: "external-access",
      refresh: "external-refresh",
      expires: Date.now() + 60_000,
    });

    expect(isSafeToOverwriteStoredOAuthIdentity(existing, incoming)).toBe(false);
    expect(isSafeToAdoptBootstrapOAuthIdentity(existing, incoming)).toBe(true);
  });
});

describe("isSafeToAdoptMainStoreOAuthIdentity", () => {
  it("allows identity-less credentials to adopt from the main store", () => {
    expect(
      isSafeToAdoptMainStoreOAuthIdentity(
        createCredential({
          access: "sub-access",
          refresh: "sub-refresh",
        }),
        createCredential({
          access: "main-access",
          refresh: "main-refresh",
          accountId: "acct-main",
        }),
      ),
    ).toBe(true);
  });

  it("accepts matching account identities", () => {
    expect(
      isSafeToAdoptMainStoreOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({ access: "main-access", refresh: "main-refresh", accountId: "acct-123" }),
      ),
    ).toBe(true);
  });
});

describe("OAuthManagerRefreshError", () => {
  it("serializes without leaking credential or store secrets", () => {
    const refreshedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": createCredential({
          access: "store-access",
          refresh: "store-refresh",
        }),
      },
    };
    const error = new OAuthManagerRefreshError({
      credential: createCredential({ access: "error-access", refresh: "error-refresh" }),
      profileId: "openai-codex:default",
      refreshedStore,
      cause: new Error("boom"),
    });

    const serialized = JSON.stringify(error);
    expect(serialized).toContain("openai-codex");
    expect(serialized).toContain("openai-codex:default");
    expect(serialized).not.toContain("error-access");
    expect(serialized).not.toContain("error-refresh");
    expect(serialized).not.toContain("store-access");
    expect(serialized).not.toContain("store-refresh");
  });
});

describe("createOAuthManager", () => {
  it("refreshes with the adopted external oauth credential", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-refresh-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(mainAgentDir, { recursive: true });
    const profileId = "minimax-portal:default";
    const localCredential = createCredential({
      provider: "minimax-portal",
      access: "stale-local-access",
      refresh: "stale-local-refresh",
      expires: Date.now() - 60_000,
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: localCredential,
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

    const manager = createOAuthManager({
      buildApiKey: async (_provider, credential) => credential.access,
      refreshCredential: vi.fn(async (credential) => {
        expect(credential.refresh).toBe("external-refresh");
        return {
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 60_000,
        };
      }),
      readBootstrapCredential: () =>
        createCredential({
          provider: "minimax-portal",
          access: "expired-external-access",
          refresh: "external-refresh",
          expires: Date.now() - 30_000,
        }),
      isRefreshTokenReusedError: () => false,
    });

    const result = await manager.resolveOAuthAccess({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      credential: localCredential,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "rotated-access",
      credential: expect.objectContaining({
        provider: "minimax-portal",
        access: "rotated-access",
        refresh: "rotated-refresh",
      }),
    });
  });

  it("shares one in-flight refresh result across concurrent callers", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-singleflight-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await fs.mkdir(mainAgentDir, { recursive: true });

    const profileId = "openai-codex:default";
    const expiredCredential = createCredential({
      access: "stale-access",
      refresh: "stale-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-123",
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: expiredCredential,
        },
      },
      mainAgentDir,
      { filterExternalAuthProfiles: false },
    );

    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const manager = createOAuthManager({
      buildApiKey: async (_provider, credential) => credential.access,
      refreshCredential: vi.fn(async () => {
        refreshCalls += 1;
        await refreshStarted;
        return {
          access: "shared-access",
          refresh: "shared-refresh",
          expires: Date.now() + 60_000,
        };
      }),
      readBootstrapCredential: () => null,
      isRefreshTokenReusedError: () => false,
    });

    const staleA = ensureAuthProfileStore(mainAgentDir).profiles[profileId] as OAuthCredential;
    const first = manager.resolveOAuthAccess({
      store: ensureAuthProfileStore(mainAgentDir),
      profileId,
      credential: staleA,
      agentDir: mainAgentDir,
    });
    const staleB = loadAuthProfileStoreForSecretsRuntime(mainAgentDir).profiles[
      profileId
    ] as OAuthCredential;
    const second = manager.resolveOAuthAccess({
      store: ensureAuthProfileStore(mainAgentDir),
      profileId,
      credential: staleB,
      agentDir: mainAgentDir,
    });

    releaseRefresh();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(refreshCalls).toBe(1);
    expect(firstResult).toMatchObject({ apiKey: "shared-access" });
    expect(secondResult).toMatchObject({ apiKey: "shared-access" });
    const persisted = loadAuthProfileStoreForSecretsRuntime(mainAgentDir).profiles[
      profileId
    ] as OAuthCredential;
    expect(persisted.access).toBe("shared-access");
    expect(persisted.refresh).toBe("shared-refresh");
  });

  it("fails closed when refreshed credentials cannot be persisted", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-persist-fail-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await fs.mkdir(mainAgentDir, { recursive: true });

    const profileId = "openai-codex:default";
    const expiredCredential = createCredential({
      access: "stale-access",
      refresh: "stale-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-123",
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: expiredCredential,
        },
      },
      mainAgentDir,
      { filterExternalAuthProfiles: false },
    );

    const originalSave = storeModule.saveAuthProfileStore;
    const saveSpy = vi
      .spyOn(storeModule, "saveAuthProfileStore")
      .mockImplementation((store, agentDir, options) => {
        const profile = store.profiles[profileId];
        if (profile?.type === "oauth" && profile.access === "broken-access") {
          throw new Error("disk full");
        }
        return originalSave(store, agentDir, options);
      });

    const manager = createOAuthManager({
      buildApiKey: async (_provider, credential) => credential.access,
      refreshCredential: vi.fn(async () => ({
        access: "broken-access",
        refresh: "broken-refresh",
        expires: Date.now() + 60_000,
      })),
      readBootstrapCredential: () => null,
      isRefreshTokenReusedError: () => false,
    });

    await expect(
      manager.resolveOAuthAccess({
        store: ensureAuthProfileStore(mainAgentDir),
        profileId,
        credential: ensureAuthProfileStore(mainAgentDir).profiles[profileId] as OAuthCredential,
        agentDir: mainAgentDir,
      }),
    ).rejects.toBeInstanceOf(OAuthManagerRefreshError);

    saveSpy.mockRestore();

    const persisted = loadAuthProfileStoreForSecretsRuntime(mainAgentDir).profiles[
      profileId
    ] as OAuthCredential;
    expect(persisted.access).toBe("stale-access");
    expect(persisted.refresh).toBe("stale-refresh");
  });
});
