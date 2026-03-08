import { describe, expect, it } from "vitest";
import { deriveOpenAICodexCanonicalProfileId } from "./auth-profiles/openai-codex-profile-id.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

describe("deriveOpenAICodexCanonicalProfileId", () => {
  it("derives a canonical profile id from accountId, iss, and sub", () => {
    expect(
      deriveOpenAICodexCanonicalProfileId({
        provider: "openai-codex",
        access: makeJwt({
          iss: "https://auth.openai.com",
          sub: "user_123",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_456" },
        }),
        accountId: "acct_456",
      }),
    ).toBe(
      `openai-codex:acct_456:${Buffer.from("https://auth.openai.com", "utf8").toString("base64url")}:${Buffer.from("user_123", "utf8").toString("base64url")}`,
    );
  });

  it("falls back to the JWT payload account id when accountId is missing", () => {
    expect(
      deriveOpenAICodexCanonicalProfileId({
        provider: "openai-codex",
        access: makeJwt({
          iss: "https://auth.openai.com",
          sub: "user_789",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_payload" },
        }),
      }),
    ).toBe(
      `openai-codex:acct_payload:${Buffer.from("https://auth.openai.com", "utf8").toString("base64url")}:${Buffer.from("user_789", "utf8").toString("base64url")}`,
    );
  });

  it("returns null for malformed tokens or non-codex providers", () => {
    expect(
      deriveOpenAICodexCanonicalProfileId({
        provider: "openai",
        access: "header.payload.sig",
      }),
    ).toBeNull();
    expect(
      deriveOpenAICodexCanonicalProfileId({
        provider: "openai-codex",
        access: "not-a-jwt",
      }),
    ).toBeNull();
  });
});
