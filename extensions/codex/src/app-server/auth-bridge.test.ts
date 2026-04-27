import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  refreshCodexAppServerAuthTokens,
} from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";

const oauthMocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(
    async (params: { provider?: string; context: { refresh: string } }) => {
      const refreshed = await oauthMocks.refreshOpenAICodexToken(params.context.refresh);
      return refreshed
        ? {
            ...params.context,
            ...refreshed,
            type: "oauth",
            provider: "openai-codex",
          }
        : undefined;
    },
  ),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: () => [],
  loginOpenAICodex: vi.fn(),
  refreshOpenAICodexToken: oauthMocks.refreshOpenAICodexToken,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...actual,
    resolveApiKeyForProfile: async (
      params: Parameters<typeof actual.resolveApiKeyForProfile>[0],
    ) => {
      const credential = params.store.profiles[params.profileId];
      if (!credential) {
        return null;
      }
      if (credential.type === "api_key") {
        const apiKey =
          credential.key?.trim() ||
          (credential.keyRef?.source === "env" ? process.env[credential.keyRef.id]?.trim() : "");
        return apiKey ? { apiKey, provider: credential.provider } : null;
      }
      if (credential.type === "token") {
        const apiKey =
          credential.token?.trim() ||
          (credential.tokenRef?.source === "env"
            ? process.env[credential.tokenRef.id]?.trim()
            : "");
        return apiKey ? { apiKey, provider: credential.provider, email: credential.email } : null;
      }
      let oauthCredential = credential;
      if ((oauthCredential.expires ?? 0) <= Date.now()) {
        const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
          provider: oauthCredential.provider,
          context: oauthCredential,
        });
        if (refreshed?.access) {
          oauthCredential = refreshed as typeof oauthCredential;
          params.store.profiles[params.profileId] = oauthCredential;
          if (params.agentDir) {
            actual.saveAuthProfileStore(params.store, params.agentDir);
          }
        }
      }
      const formatted = await providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin({
        provider: oauthCredential.provider,
        context: oauthCredential,
      });
      const apiKey =
        typeof formatted === "string" && formatted ? formatted : oauthCredential.access;
      return apiKey
        ? { apiKey, provider: oauthCredential.provider, email: oauthCredential.email }
        : null;
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  oauthMocks.refreshOpenAICodexToken.mockReset();
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockReset();
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockClear();
});

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    headers: { authorization: "Bearer dev-token" },
    ...overrides,
  };
}

async function writeCodexCliAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "cli-access-token",
        refresh_token: "cli-refresh-token",
        account_id: "cli-account-123",
      },
    }),
  );
}

describe("bridgeCodexAppServerStartOptions", () => {
  it("clears an inherited OpenAI API key when local Codex CLI OAuth is available", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const codexHome = path.join(agentDir, "codex-home");
    const startOptions = createStartOptions({
      env: { CODEX_HOME: "/tmp/source-codex-home", EXISTING: "1" },
      clearEnv: ["FOO"],
    });
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      await writeCodexCliAuthFile(codexHome);

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        clearEnv: ["FOO", "OPENAI_API_KEY"],
      });
      expect(startOptions.clearEnv).toEqual(["FOO"]);
      await expect(fs.access(path.join(agentDir, "harness-auth"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears an inherited OpenAI API key for an explicit Codex OAuth profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        clearEnv: ["FOO", "OPENAI_API_KEY"],
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears an inherited OpenAI API key for an explicit Codex token profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "openai-codex",
          token: "access-token",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        clearEnv: ["FOO", "OPENAI_API_KEY"],
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps an inherited OpenAI API key for an explicit Codex api-key profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          key: "explicit-api-key",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toBe(startOptions);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not clear process environment for websocket app-server connections", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({
      transport: "websocket",
      url: "ws://127.0.0.1:1455",
      clearEnv: ["FOO"],
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toBe(startOptions);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex OAuth profile through app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes an expired OpenAI Codex OAuth profile before app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-456",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "expired-access-token",
          refresh: "refresh-token",
          expires: Date.now() - 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "fresh-access-token",
        chatgptAccountId: "account-456",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex api-key profile backed by a secret ref", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    vi.stubEnv("OPENAI_CODEX_API_KEY", "ref-backed-api-key");
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          keyRef: { source: "env", provider: "default", id: "OPENAI_CODEX_API_KEY" },
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: "ref-backed-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex token profile backed by a secret ref", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    vi.stubEnv("OPENAI_CODEX_TOKEN", "ref-backed-access-token");
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "openai-codex",
          tokenRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TOKEN" },
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "ref-backed-access-token",
        chatgptAccountId: "codex@example.test",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("accepts a legacy Codex auth-provider alias for app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "codex-cli",
          token: "legacy-access-token",
          email: "legacy-codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "legacy-access-token",
        chatgptAccountId: "legacy-codex@example.test",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("answers app-server ChatGPT token refresh requests from the bound profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "refreshed-access-token",
      refresh: "refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-789",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        accessToken: "refreshed-access-token",
        chatgptAccountId: "account-789",
        chatgptPlanType: null,
      });
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("accepts a refreshed Codex OAuth credential when the stored provider is a legacy alias", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "refreshed-alias-access-token",
      refresh: "refreshed-alias-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-alias",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "codex-cli",
          access: "stale-alias-access-token",
          refresh: "alias-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-legacy",
          email: "legacy-codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        accessToken: "refreshed-alias-access-token",
        chatgptAccountId: "account-alias",
        chatgptPlanType: null,
      });
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("alias-refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves a stored ChatGPT plan type when building token login params", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
          chatgptPlanType: "pro",
        } as never,
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: "pro",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
