import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { isRecoverableOAuthRefreshFailure } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { jsonResponse, requestUrl, withProxyFixture } from "openclaw/plugin-sdk/test-env";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { fetch as undiciFetch, MockAgent, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyXaiConfig } from "./onboard.js";
import { buildXaiProvider } from "./provider-catalog.js";
import { createXaiDeviceCodeAuthMethod, createXaiOAuthAuthMethod } from "./xai-oauth-entry.js";
import { refreshXaiOAuthCredential } from "./xai-oauth.js";

const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const LEGACY_TOKEN_URL = "https://auth.x.ai/oauth/token";
const MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
const VERIFY_URL = "https://accounts.x.ai/oauth2/device";
const OVERFLOW_SECONDS = Number.MAX_SAFE_INTEGER;

const DEVICE_DISCOVERY = {
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  token_endpoint: TOKEN_URL,
};
const DEVICE_CODE = {
  device_code: "device",
  user_code: "CODE",
  verification_uri: "https://auth.x.ai/device",
  expires_in: 60,
  interval: 1,
};
const LOGIN_DEVICE_CODE = {
  ...DEVICE_CODE,
  device_code: "device-code-1",
  user_code: "ABCD-1234",
  verification_uri: VERIFY_URL,
};
const CATALOG_MODEL = { id: "grok-4.6", api_backend: "responses" };
const fetchImpl = vi.fn<typeof fetch>();

function mockResponses(...responses: Response[]) {
  responses.forEach((response) => fetchImpl.mockResolvedValueOnce(response));
}

function mockLoginFetch(deviceCode: object, tokens: object, model: object = CATALOG_MODEL) {
  mockResponses(...[DEVICE_DISCOVERY, deviceCode, tokens].map((value) => jsonResponse(value)));
  fetchImpl.mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.endsWith("/models")) {
      return jsonResponse({ data: [model] });
    }
    throw new Error(`Unexpected catalog URL: ${url}`);
  });
}

function streamResponse(source: UnderlyingSource<Uint8Array>): Response {
  return new Response(new ReadableStream<Uint8Array>(source));
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function requireStringBody(init: RequestInit | undefined): string {
  assert(typeof init?.body === "string", "expected request body to be a string");
  return init.body;
}

function expectPost(init: RequestInit | undefined, fields: Record<string, string>) {
  expect(init?.method).toBe("POST");
  expect(requireStringBody(init).split("&")).toEqual(
    expect.arrayContaining(
      Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`),
    ),
  );
}

function loginContext(overrides: Partial<ProviderAuthContext> = {}): ProviderAuthContext {
  return {
    config: {},
    isRemote: true,
    openUrl: async () => {},
    runtime: createRuntimeEnv(),
    prompter: createTestWizardPrompter(),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("unexpected browser flow");
      },
    },
    ...overrides,
  };
}

function runLogin(overrides: Partial<ProviderAuthContext> = {}) {
  return createXaiOAuthAuthMethod().run(loginContext(overrides));
}

function refresh(tokenEndpoint = TOKEN_URL) {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  return refreshXaiOAuthCredential({
    type: "oauth",
    provider: "xai",
    access: "access-1",
    refresh: "refresh-1",
    expires: 100,
    tokenEndpoint,
  });
}

function createRetiringOwner() {
  const held = createDeferred<void>();
  const release = createDeferred<void>();
  const controller = new AbortController();
  let current = true;
  return {
    async hold() {
      held.resolve();
      await release.promise;
    },
    async rejectLogin(overrides: Partial<ProviderAuthContext> = {}, advanceMs = 0) {
      const outcome = runLogin({
        ...overrides,
        signal: controller.signal,
        assertCurrent: () => assert(current, "owner retired"),
      }).catch((error: unknown) => ({ error }));
      try {
        await Promise.race([
          held.promise,
          outcome.then(() => {
            throw new Error("login ended before the held boundary");
          }),
        ]);
        current = false;
        release.resolve();
        if (advanceMs) {
          await vi.advanceTimersByTimeAsync(advanceMs);
        }
        expect(await outcome).toEqual({
          error: expect.objectContaining({ message: expect.stringContaining("owner retired") }),
        });
        expect(controller.signal.aborted).toBe(false);
      } finally {
        controller.abort();
        release.resolve();
        await outcome;
      }
    },
  };
}

describe("xAI OAuth", () => {
  beforeEach(() => {
    fetchImpl.mockReset();
    vi.stubGlobal("fetch", fetchImpl);
  });

  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries only verified Cloudflare challenge headers without reading the challenge body", async () => {
    const cancelled = vi.fn();
    const challenge = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(0x80));
            controller.close();
          },
          cancel: cancelled,
        }),
        {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        },
      );
    mockResponses(
      challenge(),
      challenge(),
      jsonResponse({ access_token: "recovered", expires_in: 3600 }),
    );
    await expect(refresh()).resolves.toMatchObject({ access: "recovered", refresh: "refresh-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated verified challenges and leaves the unconsumed grant recoverable", async () => {
    fetchImpl.mockImplementation(
      async () => new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );
    const error = await refresh().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ oauthRefreshOutcome: { outcome: "unchanged", status: 403 } });
    expect(isRecoverableOAuthRefreshFailure(error)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    [429, () => jsonResponse({}, 429)],
    [
      503,
      () =>
        new Response("<html>upstream unavailable</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    ],
    [500, () => new Response(null, { status: 500 })],
    [503, () => jsonResponse({ error: "temporarily_unavailable" }, 503)],
  ])(
    "keeps the stored sign-in after a transient HTTP %s so a later refresh succeeds",
    async (status, response) => {
      fetchImpl.mockResolvedValueOnce(response());
      const error = await refresh().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        oauthRefreshOutcome: {
          version: 1,
          phase: "token-response",
          outcome: "unchanged",
          status,
          recovery: { kind: "later", evidence: "owner-accepted-provider-retry" },
        },
      });
      expect(isRecoverableOAuthRefreshFailure(error)).toBe(true);
      mockResponses(
        jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      );
      await expect(refresh()).resolves.toMatchObject({ access: "access-2", refresh: "refresh-2" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchImpl.mock.calls) {
        expectPost(init, { grant_type: "refresh_token", refresh_token: "refresh-1" });
      }
    },
  );

  it.each([
    [429, { error: "invalid_grant" }, "rejected"],
    [500, { error: "invalid_client" }, "rejected"],
    [503, { error: "invalid_request" }, "unknown"],
    [401, { error: "invalid_grant" }, "rejected"],
    [200, { refresh_token: "possibly-consumed" }, "unknown"],
    [200, "invalid JSON", "unknown"],
  ])("never infers nonconsumption from HTTP %s", async (status, body, outcome) => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(body, status));
    const error = await refresh().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ oauthRefreshOutcome: { version: 1, status, outcome } });
    expect(isRecoverableOAuthRefreshFailure(error)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    Object.assign(new Error("reset before headers"), { code: "ECONNRESET" }),
    Object.assign(new Error("timed out before headers"), { name: "TimeoutError" }),
    new Error("unknown provider failure"),
  ])("does not infer nonconsumption before response headers: %s", async (failure) => {
    fetchImpl.mockRejectedValueOnce(failure);
    const error = await refresh().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      oauthRefreshOutcome: { version: 1, phase: "token-response", outcome: "unknown" },
    });
    expect(isRecoverableOAuthRefreshFailure(error)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("never restores a success whose body fails with a transport-looking error", async () => {
    fetchImpl.mockResolvedValueOnce(
      streamResponse({
        start(controller) {
          controller.error(Object.assign(new Error("reset after 200"), { code: "ECONNRESET" }));
        },
      }),
    );
    const error = await refresh().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ oauthRefreshFailure: { retryable: true } });
    expect(error).toMatchObject({
      oauthRefreshOutcome: { version: 1, phase: "token-response", outcome: "unknown" },
    });
    expect(isRecoverableOAuthRefreshFailure(error)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves https_proxy routing", async () => {
    await withProxyFixture(async (fixture) => {
      for (const key of ["http_proxy", "https_proxy", "all_proxy"]) {
        vi.stubEnv(key, key === "https_proxy" ? fixture.httpProxy : "");
      }
      vi.stubEnv("no_proxy", "");
      fetchImpl.mockImplementation(
        async (input, init?: RequestInit & { dispatcher?: Dispatcher }) => {
          expect(requestUrl(input)).toBe(TOKEN_URL);
          assert(init?.dispatcher, "expected proxy dispatcher");
          // The fixture refuses this destination before opening any upstream socket.
          await expect(
            undiciFetch(requestUrl(input), {
              ...init,
              body: requireStringBody(init),
              headers: Object.fromEntries(new Headers(init.headers)),
            }),
          ).rejects.toMatchObject({ cause: { code: "UND_ERR_PRX_CONN" } });
          return jsonResponse({ error: "temporarily_unavailable" }, 503);
        },
      );
      await expect(refresh()).rejects.toMatchObject({
        oauthRefreshOutcome: { status: 503, outcome: "unchanged" },
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fixture.connections).toEqual(["http:auth.x.ai"]);
      expect(fixture.originRoutes).toEqual([]);
      await fixture.waitForSocketsClosed();
    });
  });

  it.each(["OAuth", "catalog"] as const)("fences retired-owner %s redirects", async (boundary) => {
    const transport = new MockAgent();
    transport.disableNetConnect();
    fetchImpl.mockImplementation(async (input, init) => {
      const response = await undiciFetch(requestUrl(input), {
        ...init,
        body: init?.body == null ? init?.body : requireStringBody(init),
        headers: Object.fromEntries(new Headers(init?.headers)),
        dispatcher: transport,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    });
    const owner = createRetiringOwner();
    const redirectStart = boundary === "OAuth" ? XAI_OAUTH_DISCOVERY_URL : MODELS_URL;
    if (boundary === "catalog") {
      const auth = transport.get("https://auth.x.ai");
      auth.intercept({ path: "/.well-known/openid-configuration" }).reply(200, DEVICE_DISCOVERY);
      auth.intercept({ path: "/oauth2/device/code", method: "POST" }).reply(200, DEVICE_CODE);
      auth
        .intercept({ path: "/oauth2/token", method: "POST" })
        .reply(200, { access_token: "access", refresh_token: "refresh", expires_in: 60 });
    }
    const origin = transport.get(new URL(redirectStart).origin);
    origin.intercept({ path: new URL(redirectStart).pathname }).reply(async () => {
      await owner.hold();
      return { statusCode: 302, responseOptions: { headers: { location: "/retired" } } };
    });
    const redirected = vi.fn(() => ({ statusCode: 403, data: "denied" }));
    origin.intercept({ path: "/retired" }).reply(redirected);
    try {
      await owner.rejectLogin();
      expect(redirected).not.toHaveBeenCalled();
      expect(transport.pendingInterceptors()).toEqual([
        expect.objectContaining({ path: "/retired" }),
      ]);
    } finally {
      await transport.close();
    }
  });

  it.each([
    { boundary: "discovery response", requests: 1 },
    { boundary: "device prompt", requests: 2 },
    { boundary: "pending poll", requests: 3 },
    { boundary: "token response", requests: 3 },
  ])("fences retired owners after $boundary", async ({ boundary, requests }) => {
    if (boundary === "pending poll") {
      vi.useFakeTimers();
    }
    const owner = createRetiringOwner();
    let polls = 0;
    fetchImpl.mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        if (boundary === "discovery response") {
          await owner.hold();
        }
        return jsonResponse(DEVICE_DISCOVERY);
      }
      if (url.endsWith("/device/code")) {
        return jsonResponse(DEVICE_CODE);
      }
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [CATALOG_MODEL] });
      }
      if (boundary === "token response") {
        await owner.hold();
      }
      polls += 1;
      if (boundary === "pending poll" && polls === 1) {
        await owner.hold();
        return jsonResponse({ error: "authorization_pending" }, 400);
      }
      return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 60 });
    });
    await owner.rejectLogin(
      {
        prompter: createTestWizardPrompter({
          deviceCode: async () => {
            if (boundary === "device prompt") {
              await owner.hold();
            }
          },
        }),
      },
      boundary === "pending poll" ? 1_000 : 0,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(requests);
  });

  it("rejects untrusted discovered endpoints through credential refresh", async () => {
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ token_endpoint: "https://evil.test/oauth2/token" }),
    );
    await expect(refresh(LEGACY_TOKEN_URL)).rejects.toThrow("untrusted token endpoint");
  });

  it("rediscovers the current token endpoint for stale xAI OAuth credentials", async () => {
    fetchImpl.mockImplementation(async (url, init) => {
      if (requestUrl(url) === XAI_OAUTH_DISCOVERY_URL) {
        expect(init?.method).toBeUndefined();
        return jsonResponse({ token_endpoint: TOKEN_URL });
      }
      expect(requestUrl(url)).toBe(TOKEN_URL);
      expect(init?.method).toBe("POST");
      expect(requireStringBody(init)).toContain("refresh_token=refresh-1");
      return jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 120,
      });
    });
    const result = await refresh(LEGACY_TOKEN_URL);

    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      XAI_OAUTH_DISCOVERY_URL,
      TOKEN_URL,
    ]);
    expect(result).toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
      tokenEndpoint: TOKEN_URL,
    });
  });

  it.each([
    [LEGACY_TOKEN_URL, XAI_OAUTH_DISCOVERY_URL, "discovery unavailable"],
    [TOKEN_URL, TOKEN_URL, "socket hang up"],
  ])("does not retry %s after %s fails with %s", async (endpoint, request, message) => {
    fetchImpl.mockImplementation(async (url) => {
      expect(requestUrl(url)).toBe(request);
      throw new Error(message);
    });
    await expect(refresh(endpoint)).rejects.toMatchObject({ cause: { message } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a verified intermediary challenge but never infers nonconsumption from HTML alone", async () => {
    mockResponses(
      new Response("<!DOCTYPE html><html><body>Attention Required! Cloudflare</body></html>", {
        status: 403,
        headers: { "Content-Type": "text/html", "cf-mitigated": "challenge" },
      }),
      new Response("<!DOCTYPE html><html><body>Just a moment...</body></html>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      }),
      jsonResponse({ access_token: "access-2", expires_in: 120 }),
    );
    const error = await refresh().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      message: expect.stringContaining("HTML/Cloudflare challenge"),
      oauthRefreshOutcome: { outcome: "unknown", status: 403 },
    });
    expect(isRecoverableOAuthRefreshFailure(error)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves the cached xAI expiry when token lifetimes overflow safe milliseconds", async () => {
    fetchImpl.mockImplementation(async () =>
      jsonResponse({
        access_token: createJwt({ exp: OVERFLOW_SECONDS }),
        expires_in: OVERFLOW_SECONDS,
      }),
    );
    expect(await refresh()).toMatchObject({ expires: 100 });
  });

  it.each(["subscription", "api"] as const)("device-code login from %s setup", async (setup) => {
    const progress = { update: vi.fn(), stop: vi.fn() };
    mockLoginFetch(
      {
        ...LOGIN_DEVICE_CODE,
        verification_uri_complete: `${VERIFY_URL}?user_code=ABCD-1234`,
        expires_in: 900,
        interval: 5,
      },
      {
        access_token: createJwt({ exp: 4, sub: "acct-1" }),
        refresh_token: "refresh-1",
        id_token: createJwt({ sub: "acct-1", email: "dev@example.com", name: "Dev User" }),
        expires_in: 120,
      },
      {
        ...CATALOG_MODEL,
        supports_reasoning_effort: true,
        reasoning_efforts: ["low", "high", "xhigh"],
      },
    );
    const deviceCode = vi.fn(async () => {});
    const openUrl = vi.fn(async () => {});
    const log = vi.fn();
    const config = applyXaiConfig({});
    config.agents = {
      defaults: { model: { primary: "other/selected", fallbacks: ["other/fallback"] } },
    };
    if (setup === "subscription") {
      const provider = buildXaiProvider("openai-responses", "oauth");
      const model = provider.models[0];
      assert(model, "expected a catalog model for the stale config fixture");
      provider.models = [
        {
          ...model,
          id: "grok-4.6",
          name: "Stale",
          thinkingLevelMap: { xhigh: null },
          compat: { supportedReasoningEfforts: ["low", "high"] },
        },
      ];
      config.models = { providers: { xai: provider } };
    }
    const ctx = loginContext({
      config,
      openUrl,
      prompter: createTestWizardPrompter({ progress: vi.fn(() => progress), deviceCode }),
      runtime: { ...createRuntimeEnv(), log },
    });

    if (setup === "api" && ctx.config.models?.providers?.xai) {
      Object.assign(ctx.config.models.providers.xai, {
        apiKey: "fixture-api-key",
        headers: { Authorization: "Bearer fixture-key" },
        request: {
          auth: { mode: "authorization-bearer", token: "fixture-token" },
          headers: { "x-api-key": "fixture-key" },
          allowPrivateNetwork: false,
        },
      });
    }
    const result = await createXaiOAuthAuthMethod().run(ctx);

    expect(openUrl).toHaveBeenCalledWith(`${VERIFY_URL}?user_code=ABCD-1234`);
    expect(deviceCode).toHaveBeenCalledWith({
      title: "xAI OAuth",
      code: "ABCD-1234",
      expiresInMinutes: 15,
      message: "Enter this one-time code on the sign-in page.",
    });
    expect(openUrl.mock.invocationCallOrder[0]).toBeLessThan(
      deviceCode.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    const remoteLog = log.mock.calls[0]?.[0];
    expect(remoteLog).toContain(VERIFY_URL);
    expect(remoteLog).not.toContain("ABCD-1234");
    expectPost(fetchImpl.mock.calls[1]?.[1], {
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    });
    expectPost(fetchImpl.mock.calls[2]?.[1], {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-code-1",
    });

    expect(result.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      provider: "xai",
      refresh: "refresh-1",
      email: "dev@example.com",
      displayName: "Dev User",
      accountId: "acct-1",
      tokenEndpoint: TOKEN_URL,
      deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
      issuer: "https://auth.x.ai",
      authFlow: "device-code",
      access: expect.any(String),
    });
    expect(result.defaultModel).toBe("xai/grok-4.7");
    expect(result.configPatch?.agents?.defaults?.model).toEqual({
      primary: "other/selected",
      fallbacks: ["other/fallback"],
    });
    const savedProvider = result.configPatch?.models?.providers?.xai;
    expect(savedProvider).toMatchObject({
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      api: "openai-responses",
      auth: "oauth",
      apiKey: undefined,
      headers: undefined,
      request: { auth: undefined, headers: undefined },
    });
    expect(savedProvider?.models.map((model) => model.id)).toEqual(["grok-4.6"]);
    expect(
      fetchImpl.mock.calls
        .map(([input]) => requestUrl(input))
        .filter((url) => url.endsWith("/models")),
    ).toEqual([MODELS_URL]);
    expect(savedProvider?.models[0]?.thinkingLevelMap).toBeUndefined();
    expect(savedProvider?.models[0]?.compat?.supportedReasoningEfforts).toBeUndefined();
    if (setup === "api") {
      expect(savedProvider?.request?.allowPrivateNetwork).toBe(false);
    }
    expect(result.configPatch?.agents?.defaults?.models?.["xai/grok-4.7"]?.alias).toBe("Grok");
    expect(progress.update).toHaveBeenCalledWith("Waiting for xAI device authorization...");
    expect(progress.stop).toHaveBeenCalledWith("xAI OAuth complete");
  });

  it("preserves the device-code note link without a complete URI", async () => {
    mockLoginFetch(
      { ...LOGIN_DEVICE_CODE, expires_in: OVERFLOW_SECONDS, interval: OVERFLOW_SECONDS },
      { access_token: "access-token", refresh_token: "refresh-1", expires_in: 120 },
    );
    const note = vi.fn<(message: string, title?: string) => Promise<void>>(async () => {});
    const openUrl = vi.fn(async () => {});
    await runLogin({
      openUrl,
      prompter: createTestWizardPrompter({ note }),
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Code expires in 5 minutes."),
      "xAI OAuth",
    );
    const [message] = note.mock.calls[0]!;
    expect(markdownToIR(message, { linkify: false }).links.map((link) => link.href)).toEqual([
      VERIFY_URL,
    ]);
    expect(message).toContain("\nCode: ABCD-1234\n");
    expect(openUrl).toHaveBeenCalledWith(VERIFY_URL);
  });
  function startLogin(
    tokenResponse: (init: RequestInit) => Response | Promise<Response>,
    alias = false,
  ) {
    vi.useFakeTimers();
    fetchImpl.mockReset();
    const controller = new AbortController();
    const requested = createDeferred<void>();
    const pollTimes: number[] = [];
    const responses = [
      jsonResponse(DEVICE_DISCOVERY),
      jsonResponse({ ...DEVICE_CODE, expires_in: 8 }),
    ];
    fetchImpl.mockImplementation(async (input, init): Promise<Response> => {
      expect(init).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
      const next = responses[fetchImpl.mock.calls.length - 1];
      if (next) {
        return next;
      }
      expect(requestUrl(input)).toBe(TOKEN_URL);
      assert(init, "missing guarded request options");
      pollTimes.push(Date.now());
      requested.resolve();
      const response = await tokenResponse(init);
      responses.push(response);
      return response;
    });
    const outcome = (alias ? createXaiDeviceCodeAuthMethod() : createXaiOAuthAuthMethod())
      .run(loginContext({ credentialOnly: true, signal: controller.signal }))
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    return { controller, requested, responses, pollTimes, fetchImpl, outcome };
  }

  function expectReleased(login: ReturnType<typeof startLogin>) {
    expect(login.responses.every(({ bodyUsed, body }) => bodyUsed && !body?.locked)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }

  async function expectRejected(
    login: ReturnType<typeof startLogin>,
    calls = 3,
    error: unknown = expect.any(Error),
  ) {
    expect(await login.outcome).toEqual({ error });
    expect(login.fetchImpl).toHaveBeenCalledTimes(calls);
    expectReleased(login);
  }

  it.each([
    {
      name: "malformed UTF-8 128",
      bytes: Buffer.from('{"access_token":"access-\x80","refresh_token":"refresh"}', "latin1"),
    },
    ...[{}, { access_token: "access" }].map((value) => ({
      name: `invalid token schema ${JSON.stringify(value)}`,
      bytes: Buffer.from(JSON.stringify(value)),
    })),
  ])("decodes $name across byte boundaries through both public choices", async ({ bytes }) => {
    for (const alias of [false, true]) {
      const login = startLogin(
        () =>
          streamResponse({
            start(stream) {
              for (const byte of bytes) {
                stream.enqueue(Uint8Array.of(byte));
              }
              stream.close();
            },
          }),
        alias,
      );
      await expectRejected(
        login,
        3,
        expect.objectContaining({
          message: expect.stringContaining("token response is missing"),
        }),
      );
    }
  });

  it("cancels a streamed response above the byte cap before accepting credentials", async () => {
    const cancel = vi.fn();
    const login = startLogin(() =>
      streamResponse({
        start(stream) {
          stream.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        },
        cancel,
      }),
    );
    await expectRejected(login);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { stalled: true, cancel: true },
    { stalled: true, cancel: false },
    { stalled: false, cancel: true },
    { stalled: false, cancel: false },
  ])("stops authorization with stalled=$stalled cancel=$cancel", async ({ stalled, cancel }) => {
    const login = startLogin((init) =>
      stalled
        ? streamResponse({
            start(stream) {
              init.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
                once: true,
              });
            },
          })
        : jsonResponse({ error: "authorization_pending" }, 400),
    );
    await login.requested.promise;
    await vi.advanceTimersByTimeAsync(0);
    if (cancel) {
      login.controller.abort(new Error("cancelled by user"));
    } else {
      await vi.advanceTimersByTimeAsync(stalled ? 30_000 : 8_000);
    }
    await expectRejected(login, stalled || cancel ? 3 : 10);
  });

  it("preserves authorization_pending and slow_down pacing before valid tokens", async () => {
    let polls = 0;
    const login = startLogin(() => {
      polls += 1;
      return polls < 3
        ? jsonResponse({ error: polls === 1 ? "authorization_pending" : "slow_down" }, 400)
        : jsonResponse({ access_token: "access", refresh_token: "refresh" });
    });
    const startedAt = Date.now();
    await login.requested.promise;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await login.outcome).toMatchObject({ value: { profiles: [expect.any(Object)] } });
    expect(login.pollTimes.map((time) => time - startedAt)).toEqual([0, 1_000, 7_000]);
    expectReleased(login);
  });

  it("keeps device-code polling deadline monotonic so a wall-clock jump cannot end authorization early", async () => {
    const login = startLogin(() => jsonResponse({ error: "authorization_pending" }, 400));
    await login.requested.promise; // first token poll complete
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(login.pollTimes).toHaveLength(1);

    // Jump the wall clock forward by 60s. A Date.now()-seeded deadline would now
    // read as already expired and terminate the loop; a monotonic deadline is
    // unaffected and must keep polling at the normal interval.
    vi.setSystemTime(Date.now() + 60_000);
    // Advance the normal poll interval; the extra 0ms advances flush the awaited
    // continuation that resumes the poll loop.
    for (let i = 0; i < 12 && login.pollTimes.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    }

    // The next poll must still fire at the normal interval instead of being
    // aborted by the (fake) wall-clock jump.
    expect(login.pollTimes.length).toBeGreaterThan(1);
    login.controller.abort();
    await expect(login.outcome).resolves.toMatchObject({ error: expect.any(Error) });
  });
});
