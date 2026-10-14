import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as facadeLoader from "../../plugin-sdk/facade-loader.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  isSafeToCopyOAuthRoutingScope,
  isSafeToCopyOAuthIdentity,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
import { makeSeededRandom, maybe, randomAsciiString as randomString } from "./oauth-test-utils.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

describe("isSafeToCopyOAuthIdentity (unified copy gate, used for mirror and adopt)", () => {
  it("preserves Copilot credentials when the shipped policy artifact is missing", () => {
    const load = vi
      .spyOn(facadeLoader, "loadBundledPluginPublicSurfaceModuleSyncCore")
      .mockImplementation(() => {
        throw new facadeLoader.MissingPublicSurfaceError("Missing Copilot policy artifact");
      });
    try {
      expect(
        isSafeToCopyOAuthRoutingScope(
          { provider: "github-copilot", enterpriseUrl: "acme.ghe.com" },
          { provider: "github-copilot", enterpriseUrl: "acme.ghe.com" },
        ),
      ).toBe(false);
      expect(isSafeToCopyOAuthRoutingScope({ provider: "openai" }, { provider: "openai" })).toBe(
        true,
      );
    } finally {
      load.mockRestore();
    }
  });

  it.each([
    ["same enterprise host", "HTTPS://ACME.GHE.COM/", "acme.ghe.com", true],
    ["public and enterprise", undefined, "acme.ghe.com", false],
    ["unsupported host", "attacker.example", "attacker.example", false],
  ])("keeps GitHub Copilot routing scope isolated: %s", (_name, existing, incoming, expected) => {
    expect(
      isSafeToCopyOAuthRoutingScope(
        { provider: "github-copilot", enterpriseUrl: existing },
        { provider: "github-copilot", enterpriseUrl: incoming },
      ),
    ).toBe(expected);
  });

  it("rejects identity-less cross-tenant credentials even when identity adoption is otherwise allowed", () => {
    expect(
      isSafeToCopyOAuthIdentity(
        { provider: "github-copilot", enterpriseUrl: "acme.ghe.com" },
        { provider: "github-copilot", enterpriseUrl: "other.ghe.com", accountId: "acct-main" },
      ),
    ).toBe(false);
  });

  describe("non-overlapping identity fields are refused", () => {
    it("refuses when existing has only accountId and incoming has only email", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, { email: "u@example.com" })).toBe(false);
    });
  });

  describe("positive mismatch still refuses (CWE-284 protection)", () => {
    it("refuses mismatching accountIds even when emails match", () => {
      expect(
        isSafeToCopyOAuthIdentity(
          { accountId: "a", email: "u@example.com" },
          { accountId: "A", email: "u@example.com" },
        ),
      ).toBe(false);
    });

    it("refuses mismatching emails when both sides expose only email", () => {
      expect(
        isSafeToCopyOAuthIdentity({ email: "a@example.com" }, { email: "b@example.com" }),
      ).toBe(false);
    });
  });

  describe("normalization", () => {
    it.each([["User+Tag@Example.com", "user+tag@example.com", "user@example.com"]])(
      "preserves plus-addressing in %s",
      (existing, incoming, different) => {
        expect(isSafeToCopyOAuthIdentity({ email: existing }, { email: incoming })).toBe(true);
        expect(isSafeToCopyOAuthIdentity({ email: existing }, { email: different })).toBe(false);
      },
    );
  });
});

describe("shouldMirrorRefreshedOAuthCredential", () => {
  type MirrorCase = {
    name: string;
    refreshed?: OAuthCredential;
    existing: AuthProfileCredential | undefined;
    shouldMirror: boolean;
    reason: string;
  };
  const refreshed = {
    type: "oauth",
    provider: "openai",
    access: "fresh-access",
    refresh: "fresh-refresh",
    expires: 2_000,
    accountId: "acct-1",
  } as const;

  const older = { ...refreshed, access: "old", refresh: "old-refresh", expires: 1_000 };

  const cases: MirrorCase[] = [
    {
      name: "empty main store",
      existing: undefined,
      shouldMirror: true,
      reason: "no-existing-credential",
    },
    {
      name: "matching older oauth credential",
      existing: older,
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "out-of-range refreshed expiry",
      refreshed: {
        ...refreshed,
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      },
      existing: older,
      shouldMirror: false,
      reason: "incoming-not-fresher",
    },
    {
      name: "api key override",
      existing: createApiKeyCredential("openai", "operator-key"),
      shouldMirror: false,
      reason: "non-oauth-existing-credential",
    },
    {
      name: "provider mismatch",
      existing: { ...older, provider: "anthropic" },
      shouldMirror: false,
      reason: "provider-mismatch",
    },
    {
      name: "strictly fresher existing credential",
      existing: {
        type: "oauth",
        provider: "openai",
        access: "main-fresh",
        refresh: "main-fresh-refresh",
        expires: 3_000,
        accountId: "acct-1",
      },
      shouldMirror: false,
      reason: "incoming-not-fresher",
    },
  ];

  it.each(cases)(
    "returns $reason for $name",
    ({ existing, refreshed: caseRefreshed, shouldMirror, reason }) => {
      expect(
        shouldMirrorRefreshedOAuthCredential({
          existing,
          refreshed: caseRefreshed ?? refreshed,
        }),
      ).toEqual({ shouldMirror, reason });
    },
  );

  it("refuses identity regression from a known-account main credential", () => {
    expect(
      shouldMirrorRefreshedOAuthCredential({
        existing: {
          type: "oauth",
          provider: "openai",
          access: "main-identity-access",
          refresh: "main-identity-refresh",
          expires: 1_000,
          accountId: "acct-main",
        },
        refreshed: {
          type: "oauth",
          provider: "openai",
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: 2_000,
        },
      }),
    ).toEqual({
      shouldMirror: false,
      reason: "identity-mismatch-or-regression",
    });
  });
});

describe("isSafeToCopyOAuthIdentity fuzz", () => {
  it("accepts matching accountIds even when email identity differs", () => {
    const rng = makeSeededRandom(0x9a_9b_9c_9d);
    for (let i = 0; i < 500; i += 1) {
      const shared = `acct-${randomString(rng, 32) || "x"}`;
      const a = {
        accountId: shared,
        email: maybe(rng, randomString(rng, 32)),
      };
      const b = {
        accountId: shared,
        email: maybe(rng, randomString(rng, 32)),
      };
      expect(isSafeToCopyOAuthIdentity(a, b)).toBe(true);
    }
  });
});
