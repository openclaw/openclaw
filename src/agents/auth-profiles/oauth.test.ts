import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../infra/file-lock.js";
import { clearRuntimeAuthProfileStoreSnapshots, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  buildProviderAuthDoctorHintWithPlugin: vi.fn(async () => ""),
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(
    async (params: { context?: { access?: string } }) => params.context?.access,
  ),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(async () => null),
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => providerRuntimeMocks);

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
}

function cfgFor(profileId: string, provider: string, mode: "api_key" | "token" | "oauth") {
  return {
    auth: {
      profiles: {
        [profileId]: { provider, mode },
      },
    },
  } satisfies OpenClawConfig;
}

function tokenStore(params: {
  profileId: string;
  provider: string;
  token?: string;
  expires?: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "token",
        provider: params.provider,
        token: params.token,
        ...(params.expires !== undefined ? { expires: params.expires } : {}),
      },
    },
  };
}

function githubCopilotTokenStore(profileId: string, includeInlineToken = true): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "token",
        provider: "github-copilot",
        ...(includeInlineToken ? { token: "" } : {}),
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
    },
  };
}

async function resolveWithConfig(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
}) {
  return resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    store: params.store,
    profileId: params.profileId,
  });
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

async function expectResolvedApiKey(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
  expectedApiKey: string;
}) {
  const result = await resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    store: params.store,
    profileId: params.profileId,
  });
  expect(result).toEqual({
    apiKey: params.expectedApiKey, // pragma: allowlist secret
    provider: params.provider,
    email: undefined,
  });
}

beforeAll(loadOAuthModuleForTest);

beforeEach(() => {
  providerRuntimeMocks.buildProviderAuthDoctorHintWithPlugin.mockResolvedValue("");
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockImplementation(
    async (params: { context?: { access?: string } }) => params.context?.access,
  );
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValue(null);
});

afterAll(() => {
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
});

function createUsableOAuthExpiry(): number {
  return Date.now() + 30 * 60 * 1000;
}

describe("resolveApiKeyForProfile config compatibility", () => {
  it("accepts token credentials when config mode is oauth", async () => {
    const profileId = "anthropic:token";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "token",
          provider: "anthropic",
          token: "tok-123",
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "oauth"),
      store,
      profileId,
    });
    expect(result).toEqual({
      apiKey: "tok-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("rejects token credentials when config mode is api_key", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "api_key",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });

    expect(result).toBeNull();
  });

  it("rejects credentials when provider does not match config", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      profileId,
      provider: "openai",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toBeNull();
  });

  it("accepts oauth credentials when config mode is token (bidirectional compat)", async () => {
    const profileId = "anthropic:oauth";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "access-123",
          refresh: "refresh-123",
          expires: createUsableOAuthExpiry(),
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "token"),
      store,
      profileId,
    });
    // token ↔ oauth are bidirectionally compatible bearer-token auth paths.
    expect(result).toEqual({
      apiKey: "access-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });
});

describe("resolveApiKeyForProfile token expiry handling", () => {
  it("accepts token credentials when expires is undefined", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("accepts token credentials when expires is in the future", async () => {
    const profileId = "anthropic:token-valid-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
        expires: Date.now() + 60_000,
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("returns null for expired token credentials", async () => {
    const profileId = "anthropic:token-expired";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-expired",
        expires: Date.now() - 1_000,
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null for token credentials when expires is 0", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
        expires: 0,
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null for token credentials when expires is invalid (NaN)", async () => {
    const profileId = "anthropic:token-invalid-expiry";
    const store = tokenStore({
      profileId,
      provider: "anthropic",
      token: "tok-123",
    });
    store.profiles[profileId] = {
      ...store.profiles[profileId],
      type: "token",
      provider: "anthropic",
      token: "tok-123",
      expires: Number.NaN,
    };
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store,
    });
    expect(result).toBeNull();
  });
});

describe("resolveApiKeyForProfile secret refs", () => {
  it("ignores blank api_key credentials", async () => {
    const profileId = "openrouter:default";
    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "openrouter", "api_key"),
      store: {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openrouter",
            key: "   ",
          },
        },
      },
      profileId,
    });

    expect(result).toBeNull();
  });

  it("resolves api_key keyRef from env", async () => {
    const profileId = "openai:default";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-ref"; // pragma: allowlist secret
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "sk-openai-ref", // pragma: allowlist secret
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("normalizes inline api_key values from auth profiles before header use", async () => {
    const profileId = "openrouter:masked";
    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "openrouter", "api_key"),
      store: {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openrouter",
            key: " sk-or-\u202650ec ",
          },
        },
      },
      profileId,
    });

    expect(result).toEqual({
      apiKey: "sk-or-50ec", // pragma: allowlist secret
      provider: "openrouter",
      email: undefined,
    });
  });

  it("resolves token tokenRef from env", async () => {
    const profileId = "github-copilot:default";
    await withEnvVar("GITHUB_TOKEN", "gh-ref-token", async () => {
      await expectResolvedApiKey({
        profileId,
        provider: "github-copilot",
        mode: "token",
        store: githubCopilotTokenStore(profileId),
        expectedApiKey: "gh-ref-token", // pragma: allowlist secret
      });
    });
  });

  it("resolves token tokenRef without inline token when expires is absent", async () => {
    const profileId = "github-copilot:no-inline-token";
    await withEnvVar("GITHUB_TOKEN", "gh-ref-token", async () => {
      await expectResolvedApiKey({
        profileId,
        provider: "github-copilot",
        mode: "token",
        store: githubCopilotTokenStore(profileId, false),
        expectedApiKey: "gh-ref-token", // pragma: allowlist secret
      });
    });
  });

  it("hard-fails when oauth mode is combined with token SecretRef input", async () => {
    const profileId = "anthropic:oauth-secretref-token";
    await expect(
      resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "anthropic", "oauth"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "anthropic",
              tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
            },
          },
        },
        profileId,
      }),
    ).rejects.toThrow(/mode is "oauth"/i);
  });

  it("resolves inline ${ENV} api_key values", async () => {
    const profileId = "openai:inline-env";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-inline"; // pragma: allowlist secret
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              key: "${OPENAI_API_KEY}",
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "sk-openai-inline", // pragma: allowlist secret
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves inline ${ENV} token values", async () => {
    const profileId = "github-copilot:inline-env";
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-inline-token";
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "github-copilot", "token"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "github-copilot",
              token: "${GITHUB_TOKEN}",
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "gh-inline-token", // pragma: allowlist secret
        provider: "github-copilot",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
  });
});

describe("resolveApiKeyForProfile refresh diagnostics", () => {
  it("surfaces refresh contention once without lock-path details", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const lockPath = "/tmp/openclaw-refresh-contention.lock";
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-refresh-contention-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    const agentDir = path.join(tempRoot, "agents", "default", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const lockCause = Object.assign(new Error(`file lock timeout for ${lockPath}`), {
      code: FILE_LOCK_TIMEOUT_ERROR_CODE,
      lockPath,
    });
    providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockRejectedValue(
      Object.assign(
        new Error(
          `OAuth refresh failed (refresh_contention): another process is already refreshing ${provider} for ${profileId}. Please wait for the in-flight refresh to finish and retry.`,
          { cause: lockCause },
        ),
        {
          code: "refresh_contention",
          cause: lockCause,
        },
      ),
    );

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider,
          access: "expired-access",
          refresh: "refresh-token",
          expires: Date.now() - 60_000,
        },
      },
    };
    saveAuthProfileStore(store, agentDir, { filterExternalAuthProfiles: false });

    try {
      await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, provider, "oauth"),
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(
        `OAuth token refresh failed for ${provider}: OAuth refresh failed (refresh_contention)`,
      );
      expect(message.match(/OAuth token refresh failed/g)?.length).toBe(1);
      expect(message.match(/OAuth refresh failed \(refresh_contention\)/g)?.length).toBe(1);
      expect(message).not.toContain(lockPath);
      expect(message).not.toContain("file lock timeout");
      return;
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    throw new Error("expected OAuth refresh contention failure");
  });
});
