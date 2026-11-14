import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { Agent, createServer, get, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { isRecoverableOAuthRefreshFailure } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncGate } from "../test-support/async-gate.test-support.js";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";

const ssrfMocks = vi.hoisted(() => ({ fetchWithSsrFGuard: vi.fn() }));

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

type TokenResult = Awaited<ReturnType<typeof exchange>>;
type Failure = Extract<TokenResult, { type: "failed" }>;
type TokenOperation = Failure["operation"];
const refresh = (options?: Parameters<typeof exchange>[0]) =>
  refreshOpenAIAccessToken("old-refresh-token", options);
const tokenOperations = { exchange, refresh };

function expectTokenFailure(
  result: TokenResult,
  operation: TokenOperation,
  summary: string,
  extra = {},
) {
  if (result.type === "failed" && operation === "refresh") {
    const { oauthRefreshOutcome, ...presentation } = result;
    expect(presentation).toEqual({ type: "failed", operation, summary, ...extra });
    expect(oauthRefreshOutcome).toMatchObject({ version: 1 });
    expect(isRecoverableOAuthRefreshFailure(result)).toBe(false);
  } else {
    expect(result).toEqual({ type: "failed", operation, summary, ...extra });
  }
}

function expectTokenSuccess(
  result: TokenResult,
  access = "test-access-token",
  refreshToken = "test-refresh-token",
) {
  expect(result).toMatchObject({ type: "success", access, refresh: refreshToken });
}

function buildCallbackUrl(url: string, code = "callback-code") {
  const authorization = new URL(url);
  const redirectUri = authorization.searchParams.get("redirect_uri");
  const state = authorization.searchParams.get("state");
  if (!redirectUri || !state) {
    throw new Error("OAuth URL missing callback parameters");
  }
  const callback = new URL(redirectUri);
  callback.searchParams.set("state", state);
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

function providerError(message: string, code: string, refresh_token?: string) {
  return { error: { message, type: "invalid_request_error", code, refresh_token } };
}

async function expectRefreshFailure(
  body: unknown,
  failure: Omit<Failure, "type" | "operation" | "status">,
  message?: string,
) {
  const mockResponse = () =>
    typeof body === "string" ? mockTokenResponseText(body, 401) : mockTokenResponse(body, 401);
  mockResponse();
  expectTokenFailure(await refresh(), "refresh", failure.summary, { status: 401, ...failure });
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
  ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(tokenResponse(body, status));
}

function tokenResponse(body: string, status = 200) {
  return {
    response: new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    release: vi.fn(async () => undefined),
  };
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

      return tokenResponse(JSON.stringify(tokenPayload()));
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
    await expectRefreshFailure(
      providerError(providerMessage, "refresh_token_reused", "must-not-leak"),
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

    await expectRefreshFailure(
      providerError("Your refresh token is expired.", "refresh_token_expired"),
      {
        errorType: "invalid_request_error",
        reason: "expired",
        code: "refresh_token_expired",
        summary: "Your refresh token is expired.",
      },
    );
  });

  it.each(["before", "during"])("cancels %s setup without opening OAuth", async (timing) => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    if (timing === "before") {
      controller.abort();
    }
    const loginPromise = loginOpenAICodex({
      onAuth,
      onPrompt: vi.fn(async () => "unused-code"),
      onManualCodeInput: () => createDeferred<string>().promise,
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
            onManualCodeInput: async () => (entry === "manual input" ? "manual-code" : ""),
          }),
        ).resolves.toMatchObject({ accountId: "manual-account" });
        expect(onAuth).toHaveBeenCalledOnce();
        if (entry === "manual input") {
          expect(onPrompt).not.toHaveBeenCalled();
        } else {
          expect(onPrompt).toHaveBeenCalledOnce();
        }
        expect(ssrfMocks.fetchWithSsrFGuard.mock.calls[0]?.[0].init.body.get("code")).toBe(
          "manual-code",
        );
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each(["wrong state", "manual rejection"] as const)(
    "rejects %s without exchanging a token",
    async (failure) => {
      const onPrompt = vi.fn(async () => "unused-code");
      await expect(
        loginOpenAICodex({
          onAuth: () => undefined,
          onPrompt,
          onManualCodeInput: () =>
            failure === "wrong state"
              ? Promise.resolve("manual-code#wrong-state")
              : Promise.reject(new Error("manual entry failed")),
        }),
      ).rejects.toThrow(failure === "wrong state" ? "State mismatch" : "manual entry failed");
      expect(onPrompt).not.toHaveBeenCalled();
      expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );

  it.each(["callback", "manual input", "transport preparation"] as const)(
    "revalidates live authority after held %s before exchanging the code",
    async (boundary) => {
      const gate = createAsyncGate();
      const controller = new AbortController();
      const agent = new Agent();
      let current = true;
      const sendToken = vi.fn(async () => tokenResponse(JSON.stringify(tokenPayload("account"))));
      ssrfMocks.fetchWithSsrFGuard.mockImplementation(
        async ({ beforeRequest }: { beforeRequest?: () => void }) => {
          if (boundary === "transport preparation") {
            await gate.wait();
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
            await gate.wait();
          }
        },
        onPrompt: async () => "synthetic-code",
        onManualCodeInput: async () => {
          if (boundary === "manual input") {
            await gate.wait();
          }
          return "synthetic-code";
        },
      }).catch((error: unknown) => error);
      try {
        await gate.entered;
        current = false;
        gate.release();
        const result = await outcome;
        expect(sendToken).not.toHaveBeenCalled();
        expect(result).toMatchObject({ message: expect.stringContaining("owner retired") });
        expect(controller.signal.aborted).toBe(false);
      } finally {
        controller.abort();
        gate.release();
        await outcome;
        agent.destroy();
      }
    },
  );

  it("closes the callback listener when cancellation outlives a pending browser presentation", async () => {
    const ready = createDeferred<string>();
    const gate = createAsyncGate();
    const controller = new AbortController();
    const rejected = vi.fn();
    const login = loginOpenAICodex({
      onAuth: async ({ url }) => {
        ready.resolve(url);
        await gate.wait();
      },
      onPrompt: vi.fn(async () => "unused-code"),
      onManualCodeInput: () => createDeferred<string>().promise,
      signal: controller.signal,
    }).catch(rejected);
    let socket: Socket | undefined;
    try {
      const url = await ready.promise;
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
      gate.release();
      await login;
      socket?.destroy();
    }
  });

  it("restarts browser login while a cancelled token exchange still releases its transport", async () => {
    const transportRelease = createAsyncGate();
    const firstController = new AbortController();
    const nextController = new AbortController();
    const agent = new Agent();
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      ...tokenResponse(JSON.stringify(tokenPayload("old-account"))),
      release: transportRelease.wait,
    });
    mockTokenResponse(tokenPayload("new-account"));
    const onAuth = async ({ url }: { url: string }) => {
      const response = await requestCallback(buildCallbackUrl(url), agent);
      expect(response.body).toContain("Authorization received");
    };
    const onPrompt = vi.fn(async () => {
      throw new Error("Browser login must not fall back to manual input");
    });
    const onManualCodeInput = () => createDeferred<string>().promise;
    const first = loginOpenAICodex({
      onAuth,
      onPrompt,
      onManualCodeInput,
      signal: firstController.signal,
    }).catch(() => undefined);
    try {
      await transportRelease.entered;
      firstController.abort();
      await expect(
        loginOpenAICodex({ onAuth, onPrompt, onManualCodeInput, signal: nextController.signal }),
      ).resolves.toMatchObject({ accountId: "new-account" });
      expect(onPrompt).not.toHaveBeenCalled();
      expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    } finally {
      firstController.abort();
      nextController.abort();
      transportRelease.release();
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
    const prompter = createTestWizardPrompter({
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
    });
    const oauth: ProviderAuthContext["oauth"] = {
      createVpsAwareHandlers: (params) => ({
        onAuth: async ({ url }: { url: string }) => {
          const callback = buildCallbackUrl(url);
          idleSocket = await connectIdleSocket(callback);
          manualPrompt = params.prompter.text({
            message: "Paste callback",
            signal: params.manualPromptSignal,
          });
          callbackResponse = requestCallback(callback, agent);
          await callbackResponse;
        },
        onPrompt: async () => await (manualPrompt ?? Promise.reject(new Error("no prompt"))),
      }),
    };

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
      expect(response.body).toContain("Authorization received");
      await vi.waitFor(() => expect(manualPromptAborted).toBe(true));
      expect(Object.keys(agent.freeSockets)).toHaveLength(0);
      await vi.waitFor(() => expect(idleSocket?.destroyed).toBe(true));
    } finally {
      idleSocket?.destroy();
      agent.destroy();
    }
  });

  it.each([200, 502])(
    "reports authorization receipt before token exchange returns %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 302 })),
      );
      mockTokenResponse(status === 200 ? tokenPayload("receipt-account") : {}, status);
      const stop = vi.fn();
      const agent = new Agent();
      const prompter = createTestWizardPrompter({
        progress: () => ({ update: vi.fn(), stop }),
      });
      try {
        const login = loginOpenAICodexOAuth({
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          oauth: {
            createVpsAwareHandlers: () => ({
              onAuth: async ({ url }) => {
                const { body } = await requestCallback(buildCallbackUrl(url), agent);
                expect(body).toContain("<h1>Authorization received</h1>");
                expect(body).not.toMatch(/successful|completed|OAuth complete/i);
                expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
                expect(stop).not.toHaveBeenCalled();
              },
              onPrompt: vi.fn(async () => "unused-code"),
            }),
          },
          isRemote: false,
          openUrl: vi.fn(async () => undefined),
          onManualCodeInput: () => createDeferred<string>().promise,
        });
        if (status === 200) {
          await expect(login).resolves.toMatchObject({ accountId: "receipt-account" });
          expect(stop).toHaveBeenCalledExactlyOnceWith("OpenAI OAuth complete");
        } else {
          await expect(login).rejects.toThrow("OpenAI Codex token exchange failed (HTTP 502)");
          expect(stop).toHaveBeenCalledExactlyOnceWith("OpenAI OAuth failed");
        }
      } finally {
        agent.destroy();
      }
    },
  );

  it("stops local progress before prompting after the callback grace period", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    mockTokenResponse(tokenPayload("manual-account"));
    const events: string[] = [];
    const ready = createDeferred<void>();
    const controller = new AbortController();
    const onPrompt = vi.fn(async () => {
      events.push("prompt");
      return "manual-code";
    });
    const prompter = createTestWizardPrompter({
      progress: () => ({ update: () => {}, stop: () => events.push("stop") }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const login = loginOpenAICodexOAuth({
      prompter,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      oauth: {
        createVpsAwareHandlers: () => ({ onAuth: async () => ready.resolve(), onPrompt }),
      },
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
      signal: controller.signal,
    });
    try {
      await ready.promise;
      await vi.advanceTimersByTimeAsync(15_999);
      expect(onPrompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(login).resolves.toMatchObject({ accountId: "manual-account" });
      expect(events).toEqual(["stop", "prompt"]);
    } finally {
      controller.abort();
      vi.useRealTimers();
      await login.catch(() => undefined);
    }
  });

  it.each([
    ["/opt/homebrew/Cellar/node/26.12.1/bin/node", " /ignored-prefix ", "/opt/homebrew"],
    ["/usr/local/bin/node", " /custom-prefix ", "/custom-prefix"],
  ])(
    "shows the certificate repair path for %s before starting OAuth",
    async (execPath, envPrefix, prefix) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "execPath");
      vi.stubEnv("HOMEBREW_PREFIX", envPrefix);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed", {
            cause: {
              code: "ERR_TLS_CERT_ALTNAME_INVALID",
              message: "certificate hostname mismatch",
            },
          });
        }),
      );
      const prompter = createTestWizardPrompter();
      const createVpsAwareHandlers = vi.fn(() => {
        throw new Error("OAuth must not start after failed prerequisites");
      });
      const openUrl = vi.fn(async () => undefined);
      Object.defineProperty(process, "execPath", { configurable: true, value: execPath });
      try {
        await expect(
          loginOpenAICodexOAuth({
            prompter,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            oauth: { createVpsAwareHandlers },
            isRemote: false,
            openUrl,
          }),
        ).rejects.toThrow("prerequisites failed");
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining(`Verify cert bundle exists: ${prefix}/etc/openssl@3/cert.pem`),
          "OAuth prerequisites",
        );
        expect(createVpsAwareHandlers).not.toHaveBeenCalled();
        expect(openUrl).not.toHaveBeenCalled();
        expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
      } finally {
        if (descriptor) {
          Object.defineProperty(process, "execPath", descriptor);
        }
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["exchange", "refresh"] as const)("times out token %s requests", async (operation) => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError"),
    );
    const result = await tokenOperations[operation]({ timeoutMs: 5 });
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ auditContext: "openai-chatgpt-oauth-token", timeoutMs: 5 }),
    );
    expectTokenFailure(result, operation, `OpenAI Codex token ${operation} timed out after 5ms`);
  });

  it.each([
    ["exchange", "198.18.0.42", 4],
    ["refresh", "fc00::42", 6],
  ] as const)("allows fake-IP DNS for the OpenAI OAuth %s", async (operation, address, family) => {
    mockFakeIpTokenResponse({ address, family });
    const result = await tokenOperations[operation]();
    expectTokenSuccess(result);
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: {
          allowRfc2544BenchmarkRange: true,
          allowIpv6UniqueLocalRange: true,
          hostnameAllowlist: ["auth.openai.com"],
        },
      }),
    );
  });

  it.each([
    ["exchange", "1e309"],
    ["refresh", "0"],
  ] as const)("rejects unsafe token %s lifetimes (%s)", async (operation, lifetime) => {
    mockTokenResponseText(
      `{"access_token":"access-token","refresh_token":"refresh-token","expires_in":${lifetime}}`,
    );
    expectTokenFailure(
      await tokenOperations[operation]({ timeoutMs: 5 }),
      operation,
      `OpenAI Codex token ${operation} response missing fields: expires_in`,
    );
  });

  it.each(["exchange", "refresh"] as const)(
    "rejects malformed JSON from token %s",
    async (operation) => {
      mockTokenResponseText('{"access_token":"access-token","refresh_to');

      expectTokenFailure(
        await tokenOperations[operation](),
        operation,
        `OpenAI Codex token ${operation} failed: response is not valid JSON`,
      );
    },
  );
});

describe("OpenAI model-account credential ownership", () => {
  it.each([
    ["workspace-1", "user-1", true],
    ["workspace-1", "user-2", false],
    ["workspace-2", "user-1", false],
    ["workspace-1", undefined, false],
  ] as const)(
    "matches token identity %s/%s, never email or stored workspace metadata: %s",
    (accountId, userId, matches) => {
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
  const port = await listenOnLoopback(server);
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
    expectTokenSuccess(result, "loopback-renewed-access", "loopback-existing-refresh");
    expect(result).toHaveProperty("expires", expect.any(Number));
    if (result.type === "success") {
      expect(result.expires).toBeGreaterThan(0);
    }
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it.each([
    ["exchange", null],
    ["refresh", []],
  ] as const)(
    "rejects non-object %s responses from a real loopback HTTP server: %j",
    async (operation, value) => {
      const result = await withLoopbackTokenResponse(
        JSON.stringify(value),
        tokenOperations[operation],
      );
      expectTokenFailure(
        result,
        operation,
        `OpenAI Codex token ${operation} failed: expected JSON object response`,
      );
    },
  );

  it("rejects oversized token exchange responses from a real loopback HTTP server", async () => {
    const oversizedPayload = "o".repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const result = await withLoopbackTokenResponse(oversizedPayload);
    expect(result).toMatchObject({ type: "failed", summary: expect.stringContaining("too large") });
  });
});
