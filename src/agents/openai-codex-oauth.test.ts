import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveProxyFetchFromEnv: vi.fn(),
}));

vi.mock("../infra/net/proxy-fetch.js", () => ({
  resolveProxyFetchFromEnv: mocks.resolveProxyFetchFromEnv,
}));

import { refreshOpenAICodexOAuthToken } from "./openai-codex-oauth.js";

function encodeJwt(payload: object): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64url");
  return `header.${base64}.sig`;
}

describe("refreshOpenAICodexOAuthToken", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses proxy-aware fetch resolved from HTTP(S)_PROXY env", async () => {
    const proxiedFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: encodeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
        }),
        refresh_token: "refresh-token",
        expires_in: 3600,
      }),
    }));
    mocks.resolveProxyFetchFromEnv.mockReturnValue(proxiedFetch);

    const creds = await refreshOpenAICodexOAuthToken("refresh-token");

    expect(mocks.resolveProxyFetchFromEnv).toHaveBeenCalledOnce();
    expect(proxiedFetch).toHaveBeenCalledOnce();
    expect(creds.accountId).toBe("acct_123");
  });

  it("falls back to direct fetch when only ALL_PROXY is configured", async () => {
    const directFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: encodeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_456" },
        }),
        refresh_token: "refresh-token",
        expires_in: 3600,
      }),
    }));
    mocks.resolveProxyFetchFromEnv.mockReturnValue(undefined);
    vi.stubGlobal("fetch", directFetch);

    await refreshOpenAICodexOAuthToken("refresh-token");

    expect(mocks.resolveProxyFetchFromEnv).toHaveBeenCalledOnce();
    expect(directFetch).toHaveBeenCalledOnce();
  });
});
