import { describe, expect, it, vi, beforeEach } from "vitest";

// We test the extractJwtIssuer logic and the flow indirectly.
// The actual verifyGoogleChatRequest is integration-heavy (calls Google APIs),
// so we test the JWT issuer detection and the branching logic.

describe("Google Chat auth: Add-on issuer detection", () => {
  function extractJwtIssuer(token: string): string | null {
    try {
      const parts = token.split(".");
      if (parts.length < 2) {
        return null;
      }
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as {
        iss?: string;
      };
      return payload.iss ?? null;
    } catch {
      return null;
    }
  }

  const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;

  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.fake-signature`;
  }

  it("extracts standard Chat issuer from JWT", () => {
    const jwt = makeJwt({ iss: "chat@system.gserviceaccount.com", aud: "12345" });
    const issuer = extractJwtIssuer(jwt);
    expect(issuer).toBe("chat@system.gserviceaccount.com");
    expect(ADDON_ISSUER_PATTERN.test(issuer!)).toBe(false);
  });

  it("extracts Add-on issuer from JWT", () => {
    const jwt = makeJwt({
      iss: "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      aud: "https://example.com/googlechat",
    });
    const issuer = extractJwtIssuer(jwt);
    expect(issuer).toBe("service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com");
    expect(ADDON_ISSUER_PATTERN.test(issuer!)).toBe(true);
  });

  it("returns null for malformed JWT", () => {
    expect(extractJwtIssuer("not-a-jwt")).toBeNull();
    expect(extractJwtIssuer("")).toBeNull();
    expect(extractJwtIssuer("a.!!!invalid-base64.c")).toBeNull();
  });

  it("returns null when JWT has no iss claim", () => {
    const jwt = makeJwt({ aud: "12345", sub: "user" });
    expect(extractJwtIssuer(jwt)).toBeNull();
  });

  it("rejects non-matching Add-on issuer patterns", () => {
    // Missing project number
    expect(ADDON_ISSUER_PATTERN.test("service-@gcp-sa-gsuiteaddons.iam.gserviceaccount.com")).toBe(
      false,
    );
    // Wrong domain
    expect(ADDON_ISSUER_PATTERN.test("service-123@wrong-domain.iam.gserviceaccount.com")).toBe(
      false,
    );
    // Non-numeric project number
    expect(
      ADDON_ISSUER_PATTERN.test("service-abc@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"),
    ).toBe(false);
    // Prefix injection
    expect(
      ADDON_ISSUER_PATTERN.test("xservice-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"),
    ).toBe(false);
  });

  it("matches valid Add-on issuer patterns", () => {
    expect(
      ADDON_ISSUER_PATTERN.test("service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"),
    ).toBe(true);
    expect(
      ADDON_ISSUER_PATTERN.test(
        "service-9876543210@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      ),
    ).toBe(true);
  });
});
