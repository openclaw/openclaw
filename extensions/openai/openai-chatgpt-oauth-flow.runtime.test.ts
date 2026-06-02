// Openai tests cover openai chatgpt oauth flow plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
}));

import { openaiCodexOAuthProvider, testing } from "./openai-chatgpt-oauth-flow.runtime.js";

function timeoutError(): Error {
  return new DOMException("timed out", "TimeoutError");
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

function mockTokenResponseBytes(bytes: Uint8Array, status = 200): void {
  ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(bytes, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    release: vi.fn(async () => undefined),
  });
}

afterEach(() => {
  ssrfMocks.fetchWithSsrFGuard.mockReset();
});

describe("OpenAI Codex OAuth flow", () => {
  it("cancels provider login before opening the OAuth flow", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      openaiCodexOAuthProvider.login({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "unused-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("does not open the OAuth flow after cancellation during setup", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    const loginPromise = openaiCodexOAuthProvider.login({
      onAuth,
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    });

    controller.abort();

    await expect(loginPromise).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

  it("waits for Node OAuth runtime before creating an authorization flow", async () => {
    const flow = await testing.createAuthorizationFlow("openclaw-test");
    const url = new URL(flow.url);

    expect(flow.state).toMatch(/^[a-f0-9]{32}$/u);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("originator")).toBe("openclaw-test");
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    expect(flow.redirectUri).toBe(redirectUri);
    expect(testing.callbackHost).toBe(new URL(redirectUri ?? "").hostname);
  });

  it("builds callback redirect URIs from the configured loopback host", () => {
    expect(testing.resolveRedirectUri("127.0.0.1")).toBe("http://127.0.0.1:1455/auth/callback");
  });

  it("rejects non-loopback callback bind hosts", () => {
    expect(() => testing.resolveCallbackHost({ OPENCLAW_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(
      "callback host must be localhost, 127.0.0.1, or ::1",
    );
  });

  it("times out token exchange requests", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(timeoutError());

    const result = await testing.exchangeAuthorizationCode(
      "code",
      "verifier",
      testing.resolveRedirectUri("localhost"),
      { timeoutMs: 5 },
    );

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "openai-chatgpt-oauth-token",
        timeoutMs: 5,
      }),
    );
    expect(result).toMatchObject({
      type: "failed",
      message: "OpenAI Codex token exchange timed out after 5ms",
    });
  });

  it("cancels token exchange requests with the caller signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await testing.exchangeAuthorizationCode(
      "code",
      "verifier",
      testing.resolveRedirectUri("localhost"),
      { signal: controller.signal, timeoutMs: 5 },
    );

    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: "failed",
      message: "Login cancelled",
    });
  });

  it("rejects unsafe token exchange lifetimes", async () => {
    mockTokenResponseText(
      '{"access_token":"access-token","refresh_token":"refresh-token","expires_in":1e309}',
    );

    const result = await testing.exchangeAuthorizationCode(
      "code",
      "verifier",
      testing.resolveRedirectUri("localhost"),
      { timeoutMs: 5 },
    );

    expect(result).toEqual({
      type: "failed",
      message: "OpenAI Codex token exchange response missing fields: expires_in",
    });
  });

  it("reports malformed token exchange JSON without throwing parser errors", async () => {
    mockTokenResponseBytes(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));

    const result = await testing.exchangeAuthorizationCode(
      "code",
      "verifier",
      testing.resolveRedirectUri("localhost"),
      { timeoutMs: 5 },
    );

    expect(result).toMatchObject({
      type: "failed",
      message: expect.stringMatching(/^OpenAI Codex token exchange response was not valid JSON:/u),
    });
  });

  it("times out token refresh requests", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(timeoutError());

    const result = await testing.refreshAccessToken("old-refresh-token", { timeoutMs: 5 });

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "openai-chatgpt-oauth-token",
        timeoutMs: 5,
      }),
    );
    expect(result).toMatchObject({
      type: "failed",
      message: "OpenAI Codex token refresh timed out after 5ms",
    });
  });

  it("rejects non-positive token refresh lifetimes", async () => {
    mockTokenResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 0,
    });

    const result = await testing.refreshAccessToken("old-refresh-token", { timeoutMs: 5 });

    expect(result).toEqual({
      type: "failed",
      message: "OpenAI Codex token refresh response missing fields: expires_in",
    });
  });

  it("reports malformed token refresh JSON without throwing parser errors", async () => {
    mockTokenResponseBytes(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));

    const result = await testing.refreshAccessToken("old-refresh-token", { timeoutMs: 5 });

    expect(result).toMatchObject({
      type: "failed",
      message: expect.stringMatching(/^OpenAI Codex token refresh response was not valid JSON:/u),
    });
  });

  it("marks callback responses as connection-closing", async () => {
    const server = await testing.startLocalOAuthServer("test-state");
    try {
      const response = await fetch(
        `${testing.resolveRedirectUri("localhost")}?state=test-state&code=test-code`,
      );
      await response.text();

      expect(response.headers.get("connection")).toBe("close");
      await expect(server.waitForCode()).resolves.toEqual({ code: "test-code" });
    } finally {
      server.close();
    }
  });
});
