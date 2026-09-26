import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as facadeLoader from "../../plugin-sdk/facade-loader.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  isSafeToCopyOAuthRoutingScope,
  isSafeToCopyOAuthIdentity,
  normalizeAuthEmailToken,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
import { makeSeededRandom, maybe, randomAsciiString as randomString } from "./oauth-test-utils.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

describe("normalizeAuthEmailToken", () => {
  it("preserves internal plus-addressing and unicode", () => {
    expect(normalizeAuthEmailToken("User+Tag@Example.com")).toBe("user+tag@example.com");
    expect(normalizeAuthEmailToken("  JOSÉ@Example.com ")).toBe("josé@example.com");
  });
});

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
    ["public defaults", undefined, undefined, true],
    ["public explicit URL", undefined, "https://github.com/", true],
    ["same enterprise host", "HTTPS://ACME.GHE.COM/", "acme.ghe.com", true],
    ["different enterprise hosts", "acme.ghe.com", "other.ghe.com", false],
    ["public and enterprise", undefined, "acme.ghe.com", false],
    [
      "same host with URL transport details",
      "http://fixture-user@acme.ghe.com:443/path?q=1",
      "acme.ghe.com",
      true,
    ],
    ["unsupported host", "attacker.example", "attacker.example", false],
    ["malformed URL", "https://[broken", "https://[broken", false],
    ["trailing dot is unsupported by provider", "acme.ghe.com.", "acme.ghe.com", false],
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

  describe("upgrade tolerance (primary motivator)", () => {
    it("accepts existing-no-identity adopting incoming-with-accountId", () => {
      // The #26322 upgrade case: existing cred predates accountId capture,
      // incoming has it. Must allow or the fix regresses on existing installs.
      expect(isSafeToCopyOAuthIdentity({}, { accountId: "x" })).toBe(true);
    });
  });

  describe("identity regression is refused (incoming drops existing's identity)", () => {
    it("refuses when incoming has no identity and existing has accountId", () => {
      // Was previously allowed under the permissive relaxed rule; the
      // narrower rule refuses because it would strip identity evidence.
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, {})).toBe(false);
    });

    it("refuses when incoming has no identity and existing has email", () => {
      expect(isSafeToCopyOAuthIdentity({ email: "u@example.com" }, {})).toBe(false);
    });
  });

  describe("non-overlapping identity fields are refused", () => {
    it("refuses when existing has only accountId and incoming has only email", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, { email: "u@example.com" })).toBe(false);
    });

    it("refuses when existing has only email and incoming has only accountId", () => {
      expect(isSafeToCopyOAuthIdentity({ email: "u@example.com" }, { accountId: "x" })).toBe(false);
    });
  });

  describe("positive mismatch still refuses (CWE-284 protection)", () => {
    it("refuses mismatching accountIds even when emails match", () => {
      expect(
        isSafeToCopyOAuthIdentity(
          { accountId: "a", email: "u@example.com" },
          { accountId: "b", email: "u@example.com" },
        ),
      ).toBe(false);
    });

    it("refuses mismatching emails when both sides expose only email", () => {
      expect(
        isSafeToCopyOAuthIdentity({ email: "a@example.com" }, { email: "b@example.com" }),
      ).toBe(false);
    });

    it("keeps accountId case-sensitive in the copy gate", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "X" }, { accountId: "x" })).toBe(false);
    });
  });

  describe("normalization", () => {
    it("ignores surrounding whitespace on accountId", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "  acct-1  " }, { accountId: "acct-1" })).toBe(
        true,
      );
    });

    it("ignores email case and whitespace", () => {
      expect(
        isSafeToCopyOAuthIdentity({ email: "  U@Example.com  " }, { email: "u@example.com" }),
      ).toBe(true);
    });

    it("treats empty/whitespace-only identity as absent (allowed to upgrade)", () => {
      expect(
        isSafeToCopyOAuthIdentity({ accountId: "   ", email: "" }, { accountId: "acct-main" }),
      ).toBe(true);
    });
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
      name: "non-finite existing expiry",
      existing: { ...older, expires: Number.NaN },
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "out-of-range existing expiry",
      existing: { ...older, expires: MAX_DATE_TIMESTAMP_MS + 1 },
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
      name: "identity mismatch",
      existing: { ...older, accountId: "acct-2" },
      shouldMirror: false,
      reason: "identity-mismatch-or-regression",
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
