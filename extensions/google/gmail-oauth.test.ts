import { describe, expect, it, vi } from "vitest";

vi.mock("./oauth.credentials.js", () => ({
  resolveOAuthClientConfig: () => ({
    clientId: "client-id-123",
    clientSecret: "client-secret-456",
  }),
}));

import { buildGmailAuthUrl, GMAIL_OAUTH_SCOPES } from "./gmail-oauth.js";

describe("buildGmailAuthUrl", () => {
  it("includes Gmail scopes and offline consent params", () => {
    const url = new URL(buildGmailAuthUrl({ challenge: "challenge-1", state: "state-1" }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(GMAIL_OAUTH_SCOPES.join(" "));
  });
});
