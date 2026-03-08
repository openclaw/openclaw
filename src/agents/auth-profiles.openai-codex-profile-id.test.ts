import { describe, expect, it } from "vitest";
import { makeJwt } from "../test-utils/openai-codex-profile-id.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles.js";
import {
  deriveOpenAICodexCanonicalProfileId,
  resolveOpenAICodexCompatibleProfileId,
} from "./auth-profiles/openai-codex-profile-id.js";

function makeOpenAICredential(params: {
  accountId: string;
  iss: string;
  sub: string;
  email?: string;
  expires?: number;
}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: makeJwt({
      iss: params.iss,
      sub: params.sub,
      "https://api.openai.com/auth": {
        chatgpt_account_id: params.accountId,
      },
    }),
    refresh: `refresh-${params.accountId}`,
    expires: params.expires ?? Date.now() + 60_000,
    accountId: params.accountId,
    ...(params.email ? { email: params.email } : {}),
  };
}

describe("openai-codex profile id canonicalization", () => {
  it("derives canonical profile id from accountId + iss + sub", () => {
    const id = deriveOpenAICodexCanonicalProfileId(
      makeOpenAICredential({
        accountId: "acct_123",
        iss: "https://auth.openai.com",
        sub: "user_456",
      }),
    );
    expect(id).toBe(
      `openai-codex:acct_123:${Buffer.from("https://auth.openai.com", "utf8").toString("base64url")}:${Buffer.from("user_456", "utf8").toString("base64url")}`,
    );
  });

  it("rejects oversized JWT inputs when deriving canonical profile id", () => {
    for (const access of [`${"a".repeat(20_000)}.payload.sig`, `header.${"a".repeat(9_000)}.sig`]) {
      const id = deriveOpenAICodexCanonicalProfileId({
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct_large",
      });
      expect(id).toBeNull();
    }
  });

  it("leaves existing legacy openai-codex profile ids untouched", () => {
    const legacyProfileId = "openai-codex:legacy@example.com";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [legacyProfileId]: makeOpenAICredential({
          accountId: "acct_legacy",
          iss: "https://auth.openai.com",
          sub: "sub_legacy",
          email: "legacy@example.com",
        }),
      },
    };

    const resolved = resolveOpenAICodexCompatibleProfileId({
      store,
      profileId: legacyProfileId,
    });

    expect(resolved).toBe(legacyProfileId);
  });

  it("resolves a legacy openai-codex reference to the stored canonical profile id", () => {
    const credential = makeOpenAICredential({
      accountId: "acct_legacy",
      iss: "https://auth.openai.com",
      sub: "sub_legacy",
      email: "legacy@example.com",
    });
    const canonicalProfileId = deriveOpenAICodexCanonicalProfileId(credential)!;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [canonicalProfileId]: credential,
      },
    };

    const resolved = resolveOpenAICodexCompatibleProfileId({
      store,
      profileId: "openai-codex:legacy@example.com",
      cfg: {
        auth: {
          profiles: {
            "openai-codex:legacy@example.com": {
              provider: "openai-codex",
              mode: "oauth",
              email: "legacy@example.com",
            },
          },
        },
      },
    });

    expect(resolved).toBe(canonicalProfileId);
  });

  it("does not use lastGood fallback for non-legacy missing ids when ambiguous", () => {
    const credA = makeOpenAICredential({
      accountId: "acct_a",
      iss: "https://auth.openai.com",
      sub: "sub_a",
      email: "a@example.com",
    });
    const credB = makeOpenAICredential({
      accountId: "acct_b",
      iss: "https://auth.openai.com",
      sub: "sub_b",
      email: "b@example.com",
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [deriveOpenAICodexCanonicalProfileId(credA)!]: credA,
        [deriveOpenAICodexCanonicalProfileId(credB)!]: credB,
      },
    };
    const canonicalA = deriveOpenAICodexCanonicalProfileId(credA)!;
    store.lastGood = { "openai-codex": canonicalA };

    const resolved = resolveOpenAICodexCompatibleProfileId({
      store,
      profileId: "openai-codex:missing@example.com",
    });

    expect(resolved).toBeNull();
  });

  it("uses lastGood fallback for strict legacy openai-codex profile ids", () => {
    const credA = makeOpenAICredential({
      accountId: "acct_default_a",
      iss: "https://auth.openai.com",
      sub: "sub_default_a",
      email: "default-a@example.com",
    });
    const credB = makeOpenAICredential({
      accountId: "acct_default_b",
      iss: "https://auth.openai.com",
      sub: "sub_default_b",
      email: "default-b@example.com",
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [deriveOpenAICodexCanonicalProfileId(credA)!]: credA,
        [deriveOpenAICodexCanonicalProfileId(credB)!]: credB,
      },
    };
    const canonicalA = deriveOpenAICodexCanonicalProfileId(credA)!;
    store.lastGood = { "openai-codex": canonicalA };

    const resolved = resolveOpenAICodexCompatibleProfileId({
      store,
      profileId: "openai-codex:default",
    });

    expect(resolved).toBe(canonicalA);
  });

  it("refuses email-based resolution when multiple oauth profiles share the same email", () => {
    const credA = makeOpenAICredential({
      accountId: "acct_dup_a",
      iss: "https://auth.openai.com",
      sub: "sub_dup_a",
      email: "shared@example.com",
    });
    const credB = makeOpenAICredential({
      accountId: "acct_dup_b",
      iss: "https://auth.openai.com",
      sub: "sub_dup_b",
      email: "shared@example.com",
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [deriveOpenAICodexCanonicalProfileId(credA)!]: credA,
        [deriveOpenAICodexCanonicalProfileId(credB)!]: credB,
      },
    };

    const resolved = resolveOpenAICodexCompatibleProfileId({
      store,
      profileId: "openai-codex:shared@example.com",
      cfg: {
        auth: {
          profiles: {
            "openai-codex:shared@example.com": {
              provider: "openai-codex",
              mode: "oauth",
              email: "shared@example.com",
            },
          },
        },
      },
    });

    expect(resolved).toBeNull();
  });
});
