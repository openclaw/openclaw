import { describe, expect, it } from "vitest";
import { normalizeGitLabIssuer, validateGitLabOAuthConfig } from "./gitlab-host.js";

describe("GitLab OAuth host selection", () => {
  it("normalizes one HTTPS origin and preserves a configured callback", () => {
    expect(normalizeGitLabIssuer("https://GitLab.Example.Test/")).toBe(
      "https://gitlab.example.test",
    );
    expect(
      validateGitLabOAuthConfig({
        issuer: "https://GitLab.Example.Test/",
        clientId: "public_client-123",
        redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
      }),
    ).toEqual({
      issuer: "https://gitlab.example.test",
      clientId: "public_client-123",
      redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
    });
  });

  it.each([
    "http://gitlab.example.test",
    "https://user:secret@gitlab.example.test",
    "https://gitlab.example.test/path",
    "https://gitlab.example.test/?token=secret",
  ])("rejects issuer selection outside an exact HTTPS origin: %s", (issuer) => {
    expect(() => normalizeGitLabIssuer(issuer)).toThrow("HTTPS origin");
  });

  it("rejects callback credentials, fixed queries, fragments and HTTP", () => {
    const base = { issuer: "https://gitlab.example.test", clientId: "public-client" };
    for (const redirectUri of [
      "http://gateway.example.test/callback",
      "https://user:pass@gateway.example.test/callback",
      "https://gateway.example.test/callback#token",
      "https://gateway.example.test/callback?fixed=value",
    ]) {
      expect(() => validateGitLabOAuthConfig({ ...base, redirectUri })).toThrow();
    }
  });
});
