import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { lookup } from "node:dns/promises";
import { EventEmitter, once } from "node:events";
import { Agent, createServer, get, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
  };
});

import {
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  createOpenAIAuthorizationFlow,
  resolveOpenAICallbackHost,
  resolveOpenAIRedirectUri,
} from "./openai-chatgpt-oauth-authorization.runtime.js";
import { loginOpenAICodex, refreshOpenAICodexToken } from "./openai-chatgpt-oauth-flow.runtime.js";
import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";
import { loginOpenAICodexOAuth } from "./openai-chatgpt-oauth.runtime.js";
import { buildOpenAIProvider } from "./openai-provider.js";

function fakeJwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

function tokenPayload(accountId?: string) {
  return {
    access_token: accountId
      ? fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })
      : "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
  };
}

function exchange(options?: Parameters<typeof exchangeOpenAIAuthorizationCode>[3]) {
  return exchangeOpenAIAuthorizationCode(
    "code",
    "verifier",
    resolveOpenAIRedirectUri("localhost"),
    options,
  );
}

function expectTokenFailure(
  result: Awaited<ReturnType<typeof exchange>>,
  operation: "exchange" | "refresh",
  summary: string,
  extra = {},
) {
  expect(result).toEqual({ type: "failed", operation, summary, ...extra });
}

async function expectTokenTimeout(operation: "exchange" | "refresh", run: typeof exchange) {
  ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
  const result = await run();
  expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({ auditContext: "openai-chatgpt-oauth-token", timeoutMs: 5 }),
  );
  expectTokenFailure(result, operation, `OpenAI Codex token ${operation} timed out after 5ms`);
}

function buildCallbackUrl(url: string, code = "callback-code") {
  const authorization = new URL(url);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", code);
  return callback.toString();
}

function credential(accountId: string, userId?: string): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
      "https://api.openai.com/profile": { email: "same@example.test" },
    }),
    refresh: "synthetic-refresh",
    expires: 1,
  };
}

async function expectRefreshFailure(
  body: unknown,
  failure: Omit<
    Extract<Awaited<ReturnType<typeof refreshOpenAIAccessToken>>, { type: "failed" }>,
    "type" | "operation" | "status"
  >,
  message?: string,
) {
  const mockResponse = () =>
    typeof body === "string" ? mockTokenResponseText(body, 401) : mockTokenResponse(body, 401);
  mockResponse();
  expectTokenFailure(
    await refreshOpenAIAccessToken("old-refresh-token"),
    "refresh",
    failure.summary,
    { status: 401, ...failure },
  );
  mockResponse();
  const error = await refreshOpenAICodexToken("old-refresh-token").catch(
    (caught: unknown) => caught,
  );
  const { code: _code, ...facts } = failure;
  expect(error).toMatchObject({
    oauthRefreshFailure: { status: 401, ...facts },
    ...(message ? { message } : {}),
  });
  expect(JSON.stringify(error)).not.toContain("must-not-leak");
}

async function requestCallback(
  url: string,
  agent: Agent,
): Promise<{ headers: IncomingHttpHeaders; body: string }> {
  // A container's client DNS hints can omit IPv6 even when listen("localhost")
  // selects ::1. Keep the fixture client on the listener's resolved family.
  const { family } = await lookup(resolveOpenAICallbackHost());
  return new Promise((resolve, reject) => {
    const request = get(url, { agent, family }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
  });
}

async function connectIdleSocket(url: string): Promise<Socket> {
  const callbackUrl = new URL(url);
  const { family } = await lookup(resolveOpenAICallbackHost());
  const socket = connect({
    host: resolveOpenAICallbackHost(),
    port: Number(callbackUrl.port),
    family,
  });
  return once(socket, "connect").then(() => socket);
}

function mockTokenResponse(body: unknown, status = 200): void {
  mockTokenResponseText(JSON.stringify(body), status);
}

function mockTokenResponseText(body: string, status = 200): void {
  ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    release: vi.fn(async () => undefined),
  });
}

function mockFakeIpTokenResponse(params: { address: string; family: 4 | 6 }): void {
  ssrfMocks.fetchWithSsrFGuard.mockImplementationOnce(
    async ({ policy }: { policy?: SsrFPolicy }) => {
      const lookupFn = vi.fn(async () => [params]) as unknown as LookupFn;
      const pinned = await resolvePinnedHostnameWithPolicy("auth.openai.com", {
        lookupFn,
        policy,
      });

      expect(pinned.addresses).toEqual([params.address]);
      await expect(
        resolvePinnedHostnameWithPolicy("redirect.example.com", { lookupFn, policy }),
      ).rejects.toThrow("Blocked hostname (not in allowlist)");
      expect(lookupFn).toHaveBeenCalledOnce();

      return {
        response: new Response(JSON.stringify(tokenPayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        release: vi.fn(async () => undefined),
      };
    },
  );
}

afterEach(() => {
  ssrfMocks.fetchWithSsrFGuard.mockReset();
  vi.unstubAllGlobals();
});

describe("OpenAI Codex OAuth flow", () => {
  it("uses the provider message for failed token refreshes without exposing the response body", async () => {
    const providerMessage =
      "Your refresh token has already been used to generate a new access token. Please try signing in again.";
    const responseBody = {
      error: {
        message: providerMessage,
        type: "invalid_request_error",
        code: "refresh_token_reused",
        refresh_token: "must-not-leak",
      },
    };
    await expectRefreshFailure(
      responseBody,
      {
        reason: "refresh_token_reused",
        summary: providerMessage,
        code: "refresh_token_reused",
        errorType: "invalid_request_error",
      },
      `${providerMessage}\n\nOpenAI Codex token refresh failed (HTTP 401; code=refresh_token_reused; type=invalid_request_error).`,
    );
    await expectRefreshFailure("refresh_token=must-not-leak", {
      summary: "OpenAI Codex token refresh failed (HTTP 401).",
    });
    await expectRefreshFailure(
      { error: { code: "refresh_token_reused" } },
      {
        reason: "refresh_token_reused",
        summary: "OpenAI Codex token refresh failed (HTTP 401).",
        code: "refresh_token_reused",
      },
    );

    mockTokenResponse(
      {
        error: {
          message: "Your refresh token is expired.",
          type: "invalid_request_error",
          code: "refresh_token_expired",
        },
      },
      401,
    );
    await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toMatchObject({
      oauthRefreshFailure: {
        errorType: "invalid_request_error",
        reason: "expired",
        status: 401,
        summary: "Your refresh token is expired.",
      },
    });
  });

  it("cancels provider login before opening the OAuth flow", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      loginOpenAICodex({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "unused-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("does not open the OAuth flow after cancellation during setup", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    const loginPromise = loginOpenAICodex({
      onAuth,
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    });

    controller.abort();

    await expect(loginPromise).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

  it.each(["prompt", "manual input"] as const)(
    "uses %s when the callback port is already occupied",
    async (entry) => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(1455, resolveOpenAICallbackHost(), resolve);
      });
      const onAuth = vi.fn();
      const onPrompt = vi.fn(async () => "manual-code");
      mockTokenResponse(tokenPayload("manual-account"));
      try {
        await expect(
          loginOpenAICodex({
            onAuth,
            onPrompt,
            ...(entry === "manual input" ? { onManualCodeInput: async () => "manual-code" } : {}),
          }),
        ).resolves.toMatchObject({ accountId: "manual-account" });
        expect(onAuth).toHaveBeenCalledOnce();
        if (entry === "manual input") {
          expect(onPrompt).not.toHaveBeenCalled();
        }
        expect(ssrfMocks.fetchWithSsrFGuard.mock.calls[0]?.[0].init.body.get("code")).toBe(
          "manual-code",
        );
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each(["callback", "manual input", "transport preparation"] as const)(
    "revalidates live authority after held %s before exchanging the code",
    async (boundary) => {
      const held = createDeferred<void>();
      const release = createDeferred<void>();
      const controller = new AbortController();
      const agent = new Agent();
      let current = true;
      const sendToken = vi.fn(async () => ({
        response: new Response(JSON.stringify(tokenPayload("account"))),
        release: vi.fn(async () => undefined),
      }));
      ssrfMocks.fetchWithSsrFGuard.mockImplementation(
        async ({ beforeRequest }: { beforeRequest?: () => void }) => {
          if (boundary === "transport preparation") {
            held.resolve();
            await release.promise;
          }
          beforeRequest?.();
          return await sendToken();
        },
      );
      const outcome = loginOpenAICodex({
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner retired");
          }
        },
        onAuth: async ({ url }) => {
          if (boundary === "callback") {
            await requestCallback(buildCallbackUrl(url, "synthetic-code"), agent);
            held.resolve();
            await release.promise;
          }
        },
        onPrompt: async () => "synthetic-code",
        onManualCodeInput: async () => {
          if (boundary === "manual input") {
            held.resolve();
            await release.promise;
          }
          return "synthetic-code";
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await held.promise;
        current = false;
        release.resolve();
        const result = await outcome;
        expect(sendToken).not.toHaveBeenCalled();
        expect(result).toEqual({
          error: expect.objectContaining({ message: expect.stringContaining("owner retired") }),
        });
        expect(controller.signal.aborted).toBe(false);
      } finally {
        controller.abort();
        release.resolve();
        await outcome;
        agent.destroy();
      }
    },
  );

  it("closes the callback listener when cancellation outlives a pending browser presentation", async () => {
    const events = new EventEmitter();
    const ready = once(events, "ready");
    const release = once(events, "release");
    const controller = new AbortController();
    const rejected = vi.fn();
    const login = loginOpenAICodex({
      onAuth: async ({ url }) => {
        events.emit("ready", url);
        await release;
      },
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    }).catch(rejected);
    let socket: Socket | undefined;
    try {
      const [url] = await ready;
      const redirectUri = new URL(url).searchParams.get("redirect_uri");
      if (!redirectUri) {
        throw new Error("expected the callback redirect URI");
      }
      const callbackSocket = await connectIdleSocket(redirectUri);
      socket = callbackSocket;
      const socketErrors: Error[] = [];
      callbackSocket.on("error", (error) => socketErrors.push(error));
      const closed = new Promise<void>((resolve) => {
        callbackSocket.once("close", () => resolve());
      });
      controller.abort();
      await vi.waitFor(() =>
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Login cancelled" }),
        ),
      );
      await closed;
      expect(socket.destroyed).toBe(true);
      // Forced callback shutdown may reset a preconnected socket instead of sending FIN.
      for (const error of socketErrors) {
        expect(error).toMatchObject({ code: "ECONNRESET" });
      }
      expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      events.emit("release");
      await login;
      socket?.destroy();
    }
  });

  it("restarts browser login while a cancelled token exchange still releases its transport", async () => {
    const releasing = createDeferred<void>();
    const released = createDeferred<void>();
    const firstController = new AbortController();
    const nextController = new AbortController();
    const agent = new Agent();
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify(tokenPayload("old-account"))),
      release: async () => {
        releasing.resolve();
        await released.promise;
      },
    });
    mockTokenResponse(tokenPayload("new-account"));
    const onAuth = async ({ url }: { url: string }) => {
      const response = await requestCallback(buildCallbackUrl(url), agent);
      expect(response.body).toContain("OpenAI authentication completed");
    };
    const onPrompt = vi.fn(async () => {
      throw new Error("Browser login must not fall back to manual input");
    });
    const first = loginOpenAICodex({ onAuth, onPrompt, signal: firstController.signal }).catch(
      () => undefined,
    );
    try {
      await releasing.promise;
      firstController.abort();
      await expect(
        loginOpenAICodex({ onAuth, onPrompt, signal: nextController.signal }),
      ).resolves.toMatchObject({ accountId: "new-account" });
      expect(onPrompt).not.toHaveBeenCalled();
      expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    } finally {
      firstController.abort();
      nextController.abort();
      released.resolve();
      await first;
      agent.destroy();
    }
  });

  it("waits for Node OAuth runtime before creating an authorization flow", async () => {
    const callbackHost = resolveOpenAICallbackHost();
    const flow = await createOpenAIAuthorizationFlow(
      "openclaw-test",
      resolveOpenAIRedirectUri(callbackHost),
    );
    const url = new URL(flow.url);

    expect(flow.state).toMatch(/^[a-f0-9]{32}$/u);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("originator")).toBe("openclaw-test");
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    expect(flow.redirectUri).toBe(redirectUri);
    expect(callbackHost).toBe(new URL(redirectUri ?? "").hostname);
  });

  it("builds callback redirect URIs from the configured loopback host", () => {
    expect(resolveOpenAIRedirectUri("127.0.0.1")).toBe("http://127.0.0.1:1455/auth/callback");
  });

  it("rejects non-loopback callback bind hosts", () => {
    expect(() => resolveOpenAICallbackHost({ OPENCLAW_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(
      "callback host must be localhost, 127.0.0.1, or ::1",
    );
  });

  it("disconnects callback sockets and cancels stale manual input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    const payload = tokenPayload("acct-test");
    mockTokenResponse(payload);
    const agent = new Agent({ keepAlive: true });
    let callbackResponse: Promise<{ headers: IncomingHttpHeaders; body: string }> | undefined;
    let idleSocket: Socket | undefined;
    let manualPromptAborted = false;
    let manualPrompt: Promise<string> | undefined;
    const prompter = {
      note: vi.fn(async () => undefined),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      text: vi.fn(
        (params: { signal?: AbortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => {
                manualPromptAborted = true;
                reject(new Error("manual prompt aborted"));
              },
              { once: true },
            );
          }),
      ),
    } as unknown as ProviderAuthContext["prompter"];
    const oauth = {
      createVpsAwareHandlers: vi.fn(
        (params: Parameters<ProviderAuthContext["oauth"]["createVpsAwareHandlers"]>[0]) => ({
          onAuth: async ({ url }: { url: string }) => {
            const authUrl = new URL(url);
            const redirectUri = authUrl.searchParams.get("redirect_uri");
            const state = authUrl.searchParams.get("state");
            if (!redirectUri || !state) {
              throw new Error("OAuth URL missing callback parameters");
            }
            idleSocket = await connectIdleSocket(redirectUri);
            manualPrompt = params.prompter.text({
              message: "Paste callback",
              signal: params.manualPromptSignal,
            });
            callbackResponse = requestCallback(
              `${redirectUri}?state=${state}&code=callback-code`,
              agent,
            );
            await callbackResponse;
          },
          onPrompt: async () => await (manualPrompt ?? Promise.reject(new Error("no prompt"))),
        }),
      ),
    } satisfies ProviderAuthContext["oauth"];

    try {
      await expect(
        loginOpenAICodexOAuth({
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          oauth,
          isRemote: true,
          openUrl: vi.fn(async () => undefined),
        }),
      ).resolves.toMatchObject({ access: payload.access_token, accountId: "acct-test" });
      if (!callbackResponse) {
        throw new Error("OAuth callback request was not started");
      }
      const response = await callbackResponse;
      expect(response.headers.connection).toBe("close");
      expect(response.body).toContain("OpenAI authentication completed");
      await vi.waitFor(() => expect(manualPromptAborted).toBe(true));
      expect(Object.keys(agent.freeSockets)).toHaveLength(0);
      await vi.waitFor(() => expect(idleSocket?.destroyed).toBe(true));
    } finally {
      idleSocket?.destroy();
      agent.destroy();
    }
  });

  it("times out token exchange requests", async () => {
    await expectTokenTimeout("exchange", () => exchange({ timeoutMs: 5 }));
  });

  it.each([
    { operation: "authorization-code exchange", address: "198.18.0.42", family: 4 as const },
    { operation: "refresh-token exchange", address: "fc00::42", family: 6 as const },
  ])(
    "allows fake-IP DNS for the OpenAI OAuth $operation",
    async ({ operation, address, family }) => {
      mockFakeIpTokenResponse({ address, family });

      const result =
        operation === "authorization-code exchange"
          ? await exchange()
          : await refreshOpenAIAccessToken("old-refresh-token");

      expect(result).toMatchObject({
        type: "success",
        access: "test-access-token",
        refresh: "test-refresh-token",
      });
      expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: {
            allowRfc2544BenchmarkRange: true,
            allowIpv6UniqueLocalRange: true,
            hostnameAllowlist: ["auth.openai.com"],
          },
        }),
      );
    },
  );

  it("cancels token exchange requests with the caller signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await exchange({ signal: controller.signal, timeoutMs: 5 });
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expectTokenFailure(result, "exchange", "Login cancelled", { cancelled: true });
  });

  it("rejects unsafe token exchange lifetimes", async () => {
    mockTokenResponseText(
      '{"access_token":"access-token","refresh_token":"refresh-token","expires_in":1e309}',
    );

    expectTokenFailure(
      await exchange({ timeoutMs: 5 }),
      "exchange",
      "OpenAI Codex token exchange response missing fields: expires_in",
    );
  });

  it.each([
    {
      operation: "exchange" as const,
      run: exchange,
    },
    {
      operation: "refresh" as const,
      run: () => refreshOpenAIAccessToken("old-refresh-token"),
    },
  ])(
    "returns a failed result when the token $operation response is malformed JSON",
    async ({ operation, run }) => {
      mockTokenResponseText('{"access_token":"access-token","refresh_to');

      expectTokenFailure(
        await run(),
        operation,
        `OpenAI Codex token ${operation} failed: response is not valid JSON`,
      );
    },
  );

  it("times out token refresh requests", async () => {
    await expectTokenTimeout("refresh", () =>
      refreshOpenAIAccessToken("old-refresh-token", { timeoutMs: 5 }),
    );
  });

  it("rejects non-positive token refresh lifetimes", async () => {
    mockTokenResponse({ ...tokenPayload(), expires_in: 0 });
    expectTokenFailure(
      await refreshOpenAIAccessToken("old-refresh-token", { timeoutMs: 5 }),
      "refresh",
      "OpenAI Codex token refresh response missing fields: expires_in",
    );
  });

  it("preserves the shared 30-second token-refresh deadline", async () => {
    mockTokenResponse(tokenPayload());

    await refreshOpenAIAccessToken("existing-refresh-token");

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});

describe("OpenAI model-account credential ownership", () => {
  it.each([
    { name: "same user and workspace", accountId: "workspace-1", userId: "user-1", matches: true },
    {
      name: "another workspace member",
      accountId: "workspace-1",
      userId: "user-2",
      matches: false,
    },
    {
      name: "the same user in another workspace",
      accountId: "workspace-2",
      userId: "user-1",
      matches: false,
    },
    { name: "missing user claims", accountId: "workspace-1", userId: undefined, matches: false },
  ])(
    "matches $name from token claims, never email or stored workspace metadata",
    ({ accountId, userId, matches }) => {
      const incoming = credential("workspace-1", "user-1");
      for (const methodId of ["oauth", "device-code"]) {
        const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
        expect(method?.matchesPersonalAccount).toBeTypeOf("function");
        expect(
          method?.matchesPersonalAccount?.(incoming, {
            ...credential(accountId, userId),
            // Identical stored metadata must not substitute for the actual token identity.
            accountId: "workspace-1",
          }),
        ).toBe(matches);
      }
    },
  );

  it("refuses to replace any prior credential without an incoming user claim", () => {
    const incoming = credential("workspace-1");
    for (const methodId of ["oauth", "device-code"]) {
      const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
      expect(method?.matchesPersonalAccount).toBeTypeOf("function");
      expect(method?.matchesPersonalAccount?.(incoming, incoming)).toBe(false);
    }
  });
});

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function withLoopbackTokenResponse(
  body: string,
  run: typeof exchange = () => exchange({ timeoutMs: 5000 }),
) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  const port = await listenLoopbackServer(server);
  const release = vi.fn(async () => undefined);
  try {
    ssrfMocks.fetchWithSsrFGuard.mockImplementationOnce(async ({ init, signal }) => ({
      response: await globalThis.fetch(`http://127.0.0.1:${port}`, { ...init, signal }),
      release,
    }));
    const result = await run();
    expect(release).toHaveBeenCalledOnce();
    return result;
  } finally {
    await closeServer(server);
  }
}

describe("OpenAI Codex OAuth bounded token response reads", () => {
  it("retains an unrotated refresh token from a real loopback HTTP response", async () => {
    const result = await withLoopbackTokenResponse(
      JSON.stringify({ access_token: "loopback-renewed-access", expires_in: 3600 }),
      () => refreshOpenAIAccessToken("loopback-existing-refresh"),
    );
    expect(result).toMatchObject({
      type: "success",
      access: "loopback-renewed-access",
      refresh: "loopback-existing-refresh",
    });
  });

  it.each([
    { operation: "exchange", envelope: "null", value: null },
    { operation: "refresh", envelope: "array", value: [] },
  ] as const)(
    "rejects $envelope $operation token responses from a real loopback HTTP server",
    async ({ operation, value }) => {
      const result = await withLoopbackTokenResponse(
        JSON.stringify(value),
        operation === "exchange"
          ? exchange
          : () => refreshOpenAIAccessToken("refresh-token-loopback"),
      );
      expectTokenFailure(
        result,
        operation,
        `OpenAI Codex token ${operation} failed: expected JSON object response`,
      );
    },
  );

  it("reads under-cap token exchange responses from a real loopback HTTP server", async () => {
    const result = await withLoopbackTokenResponse(JSON.stringify(tokenPayload()));
    expect(result).toMatchObject({
      type: "success",
      access: "test-access-token",
      refresh: "test-refresh-token",
    });
    expect(result).toHaveProperty("expires", expect.any(Number));
    if (result.type === "success") {
      expect(result.expires).toBeGreaterThan(0);
    }
  });

  it("rejects oversized token exchange responses from a real loopback HTTP server", async () => {
    const oversizedPayload = "o".repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const result = await withLoopbackTokenResponse(oversizedPayload);
    expect(result).toMatchObject({ type: "failed", summary: expect.stringContaining("too large") });
  });
});
