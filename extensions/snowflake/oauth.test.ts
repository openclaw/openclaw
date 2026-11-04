import { createHash } from "node:crypto";
import type {
  ProviderAuthContext,
  ProviderPrepareRuntimeAuthContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import snowflakePlugin from "./index.js";
import "./oauth.js";

const { fetchGuard, startCallback, closeCallback, waitForCallback, release } = vi.hoisted(() => ({
  fetchGuard: vi.fn(),
  startCallback: vi.fn(),
  closeCallback: vi.fn(),
  waitForCallback: vi.fn(),
  release: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  startProviderOAuthLoopbackCallbackServer: startCallback,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const ISSUER = "https://example-account.snowflakecomputing.com";
const payload = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_in: 600,
  token_type: "Bearer",
  username: "TEST_USER",
};

function context(): ProviderAuthContext {
  const unexpectedPrompt = async () => {
    throw new Error("Unexpected prompt");
  };
  return {
    config: {
      models: {
        providers: {
          snowflake: {
            baseUrl: `${ISSUER}/api/v2/cortex/v1`,
            api: "openai-completions",
            models: [
              {
                id: "claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
                reasoning: false,
                input: ["text"],
                contextWindow: 200_000,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: {
      intro: async () => {},
      outro: async () => {},
      note: vi.fn(async () => {}),
      text: unexpectedPrompt,
      select: unexpectedPrompt,
      multiselect: unexpectedPrompt,
      confirm: unexpectedPrompt,
      progress: () => ({ update: () => {}, stop: () => {} }),
    },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected hosted flow");
      },
    },
  };
}

async function provider() {
  return await registerSingleProviderPlugin(snowflakePlugin);
}

async function login(ctx = context()) {
  const registered = await provider();
  const method = registered.auth.find((entry) => entry.id === "oauth");
  if (!method) {
    throw new Error("Snowflake OAuth is not registered");
  }
  return await method.run(ctx);
}

function runtimeContext(apiKey: string): ProviderPrepareRuntimeAuthContext {
  return {
    provider: "snowflake",
    modelId: "claude-sonnet-4-5",
    authMode: "oauth",
    env: {},
    apiKey,
    model: {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "snowflake",
      api: "openai-completions",
      baseUrl: `${ISSUER}/api/v2/cortex/v1`,
      reasoning: false,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

beforeEach(() => {
  startCallback.mockResolvedValue({ waitForCallback, close: closeCallback });
  waitForCallback.mockResolvedValue({ type: "authorization_code", code: "test-code" });
  closeCallback.mockResolvedValue(undefined);
  release.mockResolvedValue(undefined);
  fetchGuard.mockResolvedValue({ response: Response.json(payload), release });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("Snowflake registered auth flow", () => {
  it("binds local PKCE authorization to token exchange and returns a refreshable profile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ctx = context();
    ctx.openUrl = vi.fn(async () => {
      expect(startCallback).toHaveBeenCalledOnce();
    });
    const result = await login(ctx);
    const [openUrlCall] = vi.mocked(ctx.openUrl).mock.calls;
    assert(openUrlCall);
    const authorization = new URL(openUrlCall[0]);
    expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(authorization.searchParams.get("client_id")).toBe("LOCAL_APPLICATION");
    expect(authorization.searchParams.get("scope")).toBe("refresh_token");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    assert(fetchGuard.mock.calls[0]);
    const request = fetchGuard.mock.calls[0][0];
    const form = new URLSearchParams(request.init.body);
    expect(request.url).toBe(`${ISSUER}/oauth/token-request`);
    expect(request.maxRedirects).toBe(0);
    expect(form.get("client_id")).toBe("LOCAL_APPLICATION");
    expect(form.has("client_secret")).toBe(false);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("test-code");
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:8765/snowflake/callback");
    expect(authorization.searchParams.get("redirect_uri")).toBe(form.get("redirect_uri"));
    expect(authorization.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(form.get("code_verifier")!).digest("base64url"),
    );
    assert(startCallback.mock.calls[0]);
    expect(startCallback.mock.calls[0][0]).toMatchObject({
      expectedState: authorization.searchParams.get("state"),
      bindOnlyHostname: "127.0.0.1",
    });
    assert(result.profiles[0]);
    expect(result.profiles[0].credential).toMatchObject({
      type: "oauth",
      provider: "snowflake",
      issuer: ISSUER,
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 600_000,
    });
    expect(result.defaultModel).toBe("snowflake/claude-sonnet-4-5");
    expect(closeCallback).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["remote", "hosted", "endpoint", "explicit-key"])(
    "rejects unsupported %s setup before opening a browser",
    async (failure) => {
      const ctx = context();
      if (failure === "remote") {
        ctx.isRemote = true;
      }
      if (failure === "hosted") {
        ctx.oauth.authorize = vi.fn();
      }
      if (failure === "endpoint") {
        ctx.config = {};
      }
      if (failure === "explicit-key") {
        const configuredProvider = ctx.config.models?.providers?.snowflake;
        assert(configuredProvider);
        configuredProvider.apiKey = "test-key";
      }
      await expect(login(ctx)).rejects.toThrow(/Snowflake|snowflake/);
      expect(startCallback).not.toHaveBeenCalled();
      expect(ctx.openUrl).not.toHaveBeenCalled();
      expect(fetchGuard).not.toHaveBeenCalled();
    },
  );

  it("keeps credential-only login from choosing a model", async () => {
    const result = await login({ ...context(), credentialOnly: true });
    expect(result.profiles).toHaveLength(1);
    expect(result.defaultModel).toBeUndefined();
    expect(result.configPatch).toBeUndefined();
  });

  it("prepares the saved OAuth credential only for its original Cortex account", async () => {
    const registered = await provider();
    const result = await login();
    assert(result.profiles[0]);
    const apiKey = registered.formatApiKey!(result.profiles[0].credential);
    const prepared = await registered.prepareRuntimeAuth!(runtimeContext(apiKey));
    expect(prepared?.apiKey).toBe("test-access-token");
  });

  it.each([
    "https://other-account.snowflakecomputing.com/api/v2/cortex/v1",
    `${ISSUER}/api/v2/statements`,
    "https://example.test/api/v2/cortex/v1",
  ])("rejects a changed runtime endpoint %s before releasing the token", async (baseUrl) => {
    const registered = await provider();
    const result = await login();
    assert(result.profiles[0]);
    const credential = result.profiles[0].credential;
    if (credential.type !== "oauth") {
      throw new Error("Expected an OAuth login result");
    }
    const apiKey = registered.formatApiKey?.(credential) ?? credential.access;
    const ctx = runtimeContext(apiKey);
    ctx.model = { ...ctx.model, baseUrl };
    await expect(Promise.resolve(registered.prepareRuntimeAuth?.(ctx))).rejects.toThrow(
      /Snowflake|snowflake/,
    );
  });

  it("rejects OAuth without account binding while leaving manually supplied tokens unchanged", async () => {
    const registered = await provider();
    const ctx = runtimeContext("test-manual-token");
    await expect(registered.prepareRuntimeAuth!(ctx)).rejects.toThrow("account binding is missing");
    expect(await registered.prepareRuntimeAuth!({ ...ctx, authMode: "token" })).toBeUndefined();
  });

  it("does not exchange a code after authority is revoked while the browser opens", async () => {
    const ctx = context();
    let current = true;
    ctx.assertCurrent = () => {
      if (!current) {
        throw new Error("Login authority revoked");
      }
    };
    ctx.openUrl = async () => {
      current = false;
    };
    await expect(login(ctx)).rejects.toThrow("Login authority revoked");
    expect(fetchGuard).not.toHaveBeenCalled();
    expect(closeCallback).toHaveBeenCalledOnce();
  });

  it("discards exchanged credentials if the caller cancels", async () => {
    const controller = new AbortController();
    fetchGuard.mockImplementation(async () => {
      controller.abort();
      return { response: Response.json(payload), release };
    });
    await expect(login({ ...context(), signal: controller.signal })).rejects.toThrow(
      "Login cancelled",
    );
    expect(closeCallback).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { response: { ...payload, refresh_token: undefined }, error: /refresh token/ },
    { response: { ...payload, username: undefined }, error: /identity/ },
    { response: { ...payload, expires_in: 0 }, error: /invalid credentials/ },
  ])("rejects unusable token responses: $error", async ({ response, error }) => {
    fetchGuard.mockResolvedValue({ response: Response.json(response), release });
    await expect(login()).rejects.toThrow(error);
    expect(closeCallback).toHaveBeenCalledOnce();
  });

  it("does not echo an OAuth error response containing credentials", async () => {
    fetchGuard.mockResolvedValue({
      response: new Response("sensitive-test-value", { status: 400 }),
      release,
    });
    const result = login();
    await expect(result).rejects.toThrow("Snowflake OAuth token request failed (HTTP 400)");
    await expect(result).rejects.not.toThrow("sensitive-test-value");
  });

  it.each([true, false])(
    "refreshes with rotated=%s tokens through the registered hook",
    async (rotate) => {
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "snowflake",
        issuer: ISSUER,
        accountId: "test-account",
        access: "expired-test-access",
        refresh: "previous-test-refresh",
        expires: 1,
      };
      fetchGuard.mockResolvedValue({
        response: Response.json({
          ...payload,
          refresh_token: rotate ? "rotated-test-refresh" : undefined,
        }),
        release,
      });
      const refreshed = await (await provider()).refreshOAuth!(credential);
      expect(refreshed.refresh).toBe(rotate ? "rotated-test-refresh" : "previous-test-refresh");
      expect(refreshed.accountId).toBe("test-account");
      expect(refreshed.access).toBe("test-access-token");
      assert(fetchGuard.mock.calls[0]);
      const form = new URLSearchParams(fetchGuard.mock.calls[0][0].init.body);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("previous-test-refresh");
      expect(form.get("client_id")).toBe("LOCAL_APPLICATION");
    },
  );

  it("rejects a forged refresh destination before sending credentials", async () => {
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "snowflake",
      issuer: "https://example.test",
      access: "test-access",
      refresh: "test-refresh",
      expires: 1,
    };
    await expect((await provider()).refreshOAuth!(credential)).rejects.toThrow(/baseUrl/);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
