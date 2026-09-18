import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  ProviderAuthContext,
  ProviderPrepareRuntimeAuthContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildKimiCodingProvider } from "./provider-catalog.js";

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn<typeof fetchWithSsrFGuard>() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

function reply(payload: unknown, status = 200) {
  guardedFetch.mockResolvedValueOnce({
    response: Response.json(payload, { status }),
    finalUrl: "https://auth.kimi.com/api/oauth/token",
    release: async () => {},
  });
}

function context() {
  const presented = createDeferred<void>();
  const progress = { update: vi.fn(), stop: vi.fn() };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected manual input");
  };
  const controller = new AbortController();
  const ctx: ProviderAuthContext = {
    config: { agents: { defaults: { model: { primary: "example/model" } } } },
    credentialOnly: true,
    signal: controller.signal,
    assertCurrent: vi.fn(),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    isRemote: true,
    openUrl: vi.fn(async () => {}),
    prompter: {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      deviceCode: vi.fn(async () => {
        presented.resolve();
      }),
      text: unexpected,
      confirm: unexpected,
      select: unexpected,
      multiselect: unexpected,
      progress: () => progress,
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected callback");
      },
    },
  };
  return { ctx, controller, progress, presented: presented.promise };
}

async function method() {
  const provider = await registerSingleProviderPlugin(plugin);
  const auth = provider.auth.find((candidate) => candidate.id === "device-code");
  expect(auth, "Kimi must expose device sign-in through its registered provider").toBeDefined();
  if (!auth) {
    throw new Error("Kimi device sign-in is not registered");
  }
  return auth;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  guardedFetch.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function device(overrides: Record<string, unknown> = {}) {
  reply({
    device_code: "device-test",
    user_code: "TEST-CODE",
    verification_uri: "https://www.kimi.com/device",
    verification_uri_complete: "https://www.kimi.com/device?user_code=TEST-CODE",
    expires_in: 1800,
    interval: 5,
    ...overrides,
  });
}

function token(overrides: Record<string, unknown> = {}) {
  reply({
    access_token: "access-test",
    refresh_token: "refresh-test",
    expires_in: 900,
    token_type: "Bearer",
    ...overrides,
  });
}

it("signs in through the registered Kimi device method without changing the selected model", async () => {
  const auth = await method();
  device();
  token();
  const { ctx, presented } = context();
  const login = auth.run(ctx);
  await presented;
  await vi.advanceTimersByTimeAsync(5000);
  const result = await login;
  expect(result.profiles[0]?.credential).toMatchObject({
    type: "oauth",
    provider: "kimi",
    access: "access-test",
    refresh: "refresh-test",
    expires: Date.now() + 900_000,
  });
  expect(result.configPatch?.agents?.defaults?.model).toEqual({ primary: "example/model" });
  expect(ctx.prompter.deviceCode).toHaveBeenCalledWith(
    expect.objectContaining({ code: "TEST-CODE" }),
  );
  expect(ctx.openUrl).toHaveBeenCalledWith("https://www.kimi.com/device?user_code=TEST-CODE");
});

it("waits for the interval and keeps the slower interval after slow_down", async () => {
  const auth = await method();
  device();
  reply({ error: "slow_down" }, 400);
  reply({ error: "authorization_pending" }, 400);
  token();
  const { ctx, presented } = context();
  const login = auth.run(ctx);
  await presented;
  await vi.advanceTimersByTimeAsync(4999);
  expect(guardedFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(guardedFetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(9999);
  expect(guardedFetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await login).profiles).toHaveLength(1);
  expect(guardedFetch).toHaveBeenCalledTimes(4);
});

it.each([
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["unexpected-secret-value", "HTTP 400"],
])("stops the registered flow on %s", async (error, message) => {
  const auth = await method();
  device();
  reply({ error }, 400);
  const { ctx, presented, progress } = context();
  const login = auth.run(ctx);
  const rejected = expect(login).rejects.toThrow(message);
  await presented;
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(progress.stop).toHaveBeenCalledWith("Kimi sign-in stopped");
  expect(guardedFetch).toHaveBeenCalledTimes(2);
});

it("expires without sending a poll beyond the device deadline", async () => {
  const auth = await method();
  device({ expires_in: 3 });
  const { ctx, presented } = context();
  const login = auth.run(ctx);
  const rejected = expect(login).rejects.toThrow("expired");
  await presented;
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  expect(guardedFetch).toHaveBeenCalledTimes(1);
});

it.each(["cancelled", "revoked"])(
  "does not poll or return credentials after %s",
  async (reason) => {
    const auth = await method();
    device();
    const { ctx, controller, presented } = context();
    const login = auth.run(ctx);
    const rejected = expect(login).rejects.toThrow();
    await presented;
    if (reason === "cancelled") {
      controller.abort();
    } else {
      ctx.assertCurrent = () => {
        throw new Error("Login revoked");
      };
    }
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  },
);

it("rejects credentials when authority is revoked during the token response", async () => {
  const auth = await method();
  device();
  const { ctx, presented } = context();
  guardedFetch.mockResolvedValueOnce({
    response: Response.json({
      access_token: "late-access",
      refresh_token: "late-refresh",
      expires_in: 900,
      token_type: "Bearer",
    }),
    finalUrl: "https://auth.kimi.com/api/oauth/token",
    release: async () => {
      ctx.assertCurrent = () => {
        throw new Error("Login revoked");
      };
    },
  });
  const login = auth.run(ctx);
  const rejected = expect(login).rejects.toThrow("Login revoked");
  await presented;
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});

it.each([
  { verification_uri_complete: "https://evil.example/device" },
  { verification_uri_complete: "https://user@www.kimi.com/device" },
  { expires_in: Number.MAX_VALUE },
  { interval: -1 },
  { device_code: "" },
])("rejects malformed device presentation before opening the browser: %j", async (overrides) => {
  const auth = await method();
  device(overrides);
  const { ctx } = context();
  await expect(auth.run(ctx)).rejects.toThrow();
  expect(ctx.openUrl).not.toHaveBeenCalled();
});

const credential: OAuthCredential = {
  type: "oauth",
  provider: "kimi",
  access: "old-access",
  refresh: "old-refresh",
  expires: 1,
};

it("rotates credentials through the registered refresh hook", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  token();
  expect(provider.refreshOAuth).toBeDefined();
  await expect(provider.refreshOAuth?.(credential)).resolves.toMatchObject({
    access: "access-test",
    refresh: "refresh-test",
    expires: Date.now() + 900_000,
  });
  const body = guardedFetch.mock.calls[0]?.[0].init?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error("Expected OAuth form body");
  }
  expect(body.get("grant_type")).toBe("refresh_token");
  expect(body.get("refresh_token")).toBe("old-refresh");
});

it.each([{ expires_in: 0 }, { refresh_token: "" }, { token_type: "Basic" }])(
  "does not publish invalid refreshed credentials: %j",
  async (overrides) => {
    const provider = await registerSingleProviderPlugin(plugin);
    token(overrides);
    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow(
      "invalid sign-in credentials",
    );
    expect(credential.refresh).toBe("old-refresh");
  },
);

it.each(["rejected", "malformed"])(
  "reports %s refresh without exposing message or cause bytes",
  async (kind) => {
    const provider = await registerSingleProviderPlugin(plugin);
    if (kind === "rejected") {
      reply({ error: "secret-value", error_description: "private-value" }, 400);
    } else {
      guardedFetch.mockResolvedValueOnce({
        response: new Response('{"access_token":"secret-value","refresh_token":"private-value"'),
        finalUrl: "https://auth.kimi.com/api/oauth/token",
        release: async () => {},
      });
    }
    const error: unknown = await provider
      .refreshOAuth?.(credential)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    let cause: unknown = error;
    while (cause instanceof Error) {
      expect(cause.message).not.toMatch(/secret-value|private-value/);
      expect(cause.stack).not.toMatch(/secret-value|private-value/);
      cause = cause.cause;
    }
    expect(cause).toBeUndefined();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  },
);

it("prepares OAuth bearer auth at runtime while leaving API-key auth and catalog untouched", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = buildKimiCodingProvider();
  const params: ProviderPrepareRuntimeAuthContext = {
    provider: "kimi",
    modelId: "kimi-for-coding",
    model: {
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      api: "anthropic-messages",
      baseUrl: catalog.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    },
    env: {},
    apiKey: "runtime-access",
    authMode: "oauth",
  };
  expect(await provider.prepareRuntimeAuth?.(params)).toEqual({
    apiKey: "runtime-access",
    request: { auth: { mode: "authorization-bearer", token: "runtime-access" } },
  });
  const prepared = await provider.prepareRuntimeAuth?.(params);
  const headers = resolveProviderRequestHeaders({
    provider: "kimi",
    api: "anthropic-messages",
    baseUrl: catalog.baseUrl,
    request: prepared?.request,
  });
  expect(headers?.Authorization).toBe("Bearer runtime-access");
  expect(await provider.prepareRuntimeAuth?.({ ...params, authMode: "api_key" })).toBeUndefined();
  expect(JSON.stringify(catalog)).not.toContain("runtime-access");
});

it.each(["kimi", " KIMI "])(
  "preserves an existing %s connection through registered sign-in",
  async (providerId) => {
    const auth = await method();
    device();
    token();
    const { ctx, presented } = context();
    const connection = {
      baseUrl: "https://proxy.example/kimi/v1",
      api: "openai-completions" as const,
      models: [],
      headers: { "X-Tenant": "example" },
    };
    ctx.config.models = { providers: { [providerId]: connection } };
    const login = auth.run(ctx);
    await presented;
    await vi.advanceTimersByTimeAsync(5000);
    const result = await login;
    expect(result.configPatch?.models?.providers?.kimi).toMatchObject(connection);
    expect(result.configPatch?.agents?.defaults?.model).toEqual(ctx.config.agents?.defaults?.model);
    expect(ctx.config.models.providers?.[providerId]).toBe(connection);
    expect(connection).toEqual({
      baseUrl: "https://proxy.example/kimi/v1",
      api: "openai-completions",
      models: [],
      headers: { "X-Tenant": "example" },
    });
  },
);
