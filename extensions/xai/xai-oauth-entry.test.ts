import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { oauthRuntimeMocks, oauthRuntimeLoaded } = vi.hoisted(() => ({
  oauthRuntimeMocks: {
    loginXaiDeviceCode: vi.fn(),
    refreshXaiOAuthCredential: vi.fn(),
  },
  oauthRuntimeLoaded: vi.fn(),
}));

vi.mock("./xai-oauth.js", () => {
  oauthRuntimeLoaded();
  return oauthRuntimeMocks;
});

beforeEach(() => {
  vi.resetModules();
  oauthRuntimeMocks.loginXaiDeviceCode.mockReset();
  oauthRuntimeMocks.refreshXaiOAuthCredential.mockReset();
  oauthRuntimeMocks.loginXaiDeviceCode.mockResolvedValue({ profiles: [] });
  oauthRuntimeMocks.refreshXaiOAuthCredential.mockResolvedValue({
    type: "oauth",
    provider: "xai",
    access: "next-access",
    refresh: "next-refresh",
    expires: 123,
  });
});

describe("xAI OAuth lazy entry", () => {
  it("matches exact issuer and subject without loading OAuth", async () => {
    const entry = await import("./xai-oauth-entry.js");
    const matches = entry.createXaiOAuthAuthMethod().matchesSharedAccount;
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "xai",
      issuer: "https://issuer.example.test",
      accountId: "Subject",
      email: "fixture@example.test",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 1,
    };
    expect(matches?.(credential, { ...credential, email: "changed@example.test" })).toBe(true);
    for (const previous of [
      { ...credential, issuer: "https://other.example.test" },
      { ...credential, issuer: undefined },
      { ...credential, accountId: "subject" },
      { ...credential, accountId: undefined },
      { ...credential, provider: "other" },
      { type: "api_key", provider: "xai", key: "fixture-key" } as const,
    ]) {
      expect(matches?.(credential, previous)).toBe(false);
      expect(matches?.(previous, credential)).toBe(false);
    }
    for (const blank of [
      { ...credential, issuer: " " },
      { ...credential, accountId: " " },
    ]) {
      expect(matches?.(blank, blank)).toBe(false);
    }
    expect(oauthRuntimeLoaded).not.toHaveBeenCalled();
  });

  it("loads OAuth runtime only when an auth operation runs", async () => {
    const entry = await import("./xai-oauth-entry.js");
    const method = entry.createXaiOAuthAuthMethod();

    expect(oauthRuntimeLoaded).not.toHaveBeenCalled();
    expect(oauthRuntimeMocks.loginXaiDeviceCode).not.toHaveBeenCalled();
    expect(oauthRuntimeMocks.refreshXaiOAuthCredential).not.toHaveBeenCalled();

    await method.run({} as never);
    expect(oauthRuntimeLoaded).toHaveBeenCalledOnce();
    expect(oauthRuntimeMocks.loginXaiDeviceCode).toHaveBeenCalledOnce();

    await entry.refreshXaiOAuthCredential({
      type: "oauth",
      provider: "xai",
      access: "access",
      refresh: "refresh",
      expires: 1,
    });
    expect(oauthRuntimeLoaded).toHaveBeenCalledOnce();
    expect(oauthRuntimeMocks.refreshXaiOAuthCredential).toHaveBeenCalledOnce();
  });
});
