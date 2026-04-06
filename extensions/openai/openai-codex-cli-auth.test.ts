import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
  readOpenAICodexCliOAuthProfile,
} from "./openai-codex-cli-auth.js";

function buildJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

describe("readOpenAICodexCliOAuthProfile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads Codex CLI chatgpt auth into the default OpenAI Codex profile", () => {
    const accessToken = buildJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/profile": {
        email: "codex@example.com",
      },
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
          account_id: "acct_123",
        },
      }),
    );

    const parsed = readOpenAICodexCliOAuthProfile({
      store: { version: 1, profiles: {} },
    });

    expect(parsed).toMatchObject({
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: accessToken,
        refresh: "refresh-token",
        accountId: "acct_123",
        email: "codex@example.com",
        managedBy: "codex-cli",
      },
    });
    expect(parsed?.credential.expires).toBeGreaterThan(Date.now());
  });

  it("does not override a locally managed OpenAI Codex profile", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
    );

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
            type: "oauth",
            provider: "openai-codex",
            access: "local-access",
            refresh: "local-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
    });

    expect(parsed).toBeNull();
  });
});
