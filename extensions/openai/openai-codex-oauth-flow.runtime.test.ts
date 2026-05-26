import { describe, expect, it } from "vitest";
import { testing } from "./openai-codex-oauth-flow.runtime.js";

describe("OpenAI Codex OAuth flow", () => {
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
    expect(testing.resolveRedirectUri("127.0.0.1")).toBe(
      "http://127.0.0.1:1455/auth/callback",
    );
  });

  it("rejects non-loopback callback bind hosts", () => {
    expect(() =>
      testing.resolveCallbackHost({ OPENCLAW_OAUTH_CALLBACK_HOST: "0.0.0.0" }),
    ).toThrow("callback host must be localhost, 127.0.0.1, or ::1");
  });
});
