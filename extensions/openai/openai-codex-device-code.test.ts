import { describe, expect, it, vi } from "vitest";
import { loginOpenAICodexDeviceCode } from "./openai-codex-device-code.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function createJsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("loginOpenAICodexDeviceCode", () => {
  it("requests a device code, polls for authorization, and exchanges OAuth tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_challenge: "ignored",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 600,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
            },
            "https://api.openai.com/profile": {
              email: "codex@example.com",
            },
          }),
          refresh_token: "refresh-token-123",
          id_token: createJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
            },
          }),
          expires_in: 600,
        }),
      );
    const onVerification = vi.fn(async () => {});
    const onProgress = vi.fn();

    const credentials = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification,
      onProgress,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(onVerification).toHaveBeenCalledWith({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-12345",
      expiresInMs: 900_000,
    });
    expect(onProgress).toHaveBeenNthCalledWith(1, "Requesting device code…");
    expect(onProgress).toHaveBeenNthCalledWith(2, "Waiting for device authorization…");
    expect(onProgress).toHaveBeenNthCalledWith(3, "Exchanging device code…");
    expect(credentials).toMatchObject({
      access: expect.any(String),
      refresh: "refresh-token-123",
      accountId: "acct_123",
      idToken: expect.any(String),
    });
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  it("surfaces user-code request failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow("OpenAI device code request failed: HTTP 503");
  });

  it("surfaces device authorization failures with payload details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: "authorization_declined",
            error_description: "Denied",
          },
          { status: 401 },
        ),
      );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow("OpenAI device authorization failed: authorization_declined (Denied)");
  });
});
