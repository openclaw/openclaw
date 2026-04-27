import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureAuthProfileStore, upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  refreshCodexAppServerAuthTokens,
} from "./auth-bridge.js";

const oauthMocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(
    async (params: { context: { refresh: string } }) => {
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

vi.mock("../../../../src/plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin:
    providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin:
    providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  oauthMocks.refreshOpenAICodexToken.mockReset();
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockReset();
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockClear();
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("bridgeCodexAppServerStartOptions", () => {
  it("uses a stable CODEX_HOME for the selected named OpenAI Codex profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: { authorization: "Bearer dev-token" },
      env: { CODEX_HOME: "/tmp/source-codex-home", EXISTING: "1" },
      clearEnv: ["FOO"],
    };
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
        },
      });

      const bridged = await bridgeCodexAppServerStartOptions({
        startOptions,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(bridged).not.toBe(startOptions);
      expect(bridged.env?.EXISTING).toBe("1");
      expect(bridged.env?.CODEX_HOME).toMatch(
        new RegExp(`^${escapeRegExp(path.join(agentDir, "harness-auth", "codex", "profiles"))}`),
      );
      expect(bridged.env?.CODEX_HOME).not.toBe("/tmp/source-codex-home");
      expect(bridged.clearEnv).toEqual(
        expect.arrayContaining(["FOO", "OPENAI_API_KEY", "CODEX_API_KEY"]),
      );
      await expect(fs.access(bridged.env?.CODEX_HOME ?? "")).resolves.toBeUndefined();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves discovery starts without a selected auth profile unchanged", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: { authorization: "Bearer dev-token" },
      env: { CODEX_HOME: "/tmp/source-codex-home", EXISTING: "1" },
      clearEnv: ["FOO"],
    };
    try {
      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toBe(startOptions);
      await expect(fs.access(path.join(agentDir, "harness-auth"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an explicit OpenAI Codex auth profile is missing", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions: {
            transport: "stdio" as const,
            command: "codex",
            args: ["app-server"],
            headers: {},
          },
          agentDir,
          authProfileId: "openai-codex:missing",
        }),
      ).rejects.toThrow('Codex app-server auth profile "openai-codex:missing" was not found.');
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

  it("syncs rotated Codex CODEX_HOME OAuth tokens back before app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-access-token",
          refresh: "stale-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });
      const bridged = await bridgeCodexAppServerStartOptions({
        startOptions: {
          transport: "stdio" as const,
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        agentDir,
        authProfileId: "openai-codex:work",
      });
      const expires = Date.now() + 2 * 60 * 60_000;
      await fs.writeFile(
        path.join(bridged.env?.CODEX_HOME ?? "", "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "rotated-access-token",
            refresh_token: "rotated-refresh-token",
            expires_at: expires,
            account_id: "account-123",
            id_token: "rotated-id-token",
          },
        }),
      );

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "rotated-access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: null,
      });
      expect(ensureAuthProfileStore(agentDir).profiles["openai-codex:work"]).toMatchObject({
        type: "oauth",
        access: "rotated-access-token",
        refresh: "rotated-refresh-token",
        expires,
        idToken: "rotated-id-token",
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
