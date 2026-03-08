import { describe, expect, it } from "vitest";
import { expectedOpenAICodexProfileId, makeJwt } from "../test-utils/openai-codex-profile-id.js";
import { deriveOpenAICodexCanonicalProfileId } from "./auth-profiles/openai-codex-profile-id.js";

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
      expectedOpenAICodexProfileId({
        accountId: "acct_456",
        iss: "https://auth.openai.com",
        sub: "user_123",
      }),
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
      expectedOpenAICodexProfileId({
        accountId: "acct_payload",
        iss: "https://auth.openai.com",
        sub: "user_789",
      }),
    );
  });

  it("sanitizes account ids before building the canonical profile id", () => {
    expect(
      deriveOpenAICodexCanonicalProfileId({
        provider: "openai-codex",
        access: makeJwt({
          iss: "https://auth.openai.com",
          sub: "user_special",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct / special?" },
        }),
        accountId: "acct / special?",
      }),
    ).toBe(
      `openai-codex:acct-special:${Buffer.from("https://auth.openai.com", "utf8").toString("base64url")}:${Buffer.from("user_special", "utf8").toString("base64url")}`,
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
