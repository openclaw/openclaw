import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as facadeLoader from "../../plugin-sdk/facade-loader.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import {
  isSafeToCopyOAuthRoutingScope,
  isSafeToCopyOAuthIdentity,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
import { makeSeededRandom, maybe, randomAsciiString as randomString } from "./oauth-test-utils.js";

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

  it.each([
    ["non-overlapping fields", { accountId: "x" }, { email: "u@example.com" }],
    [
      "account mismatch despite matching email",
      { accountId: "a", email: "u@example.com" },
      { accountId: "A", email: "u@example.com" },
    ],
    ["email mismatch", { email: "a@example.com" }, { email: "b@example.com" }],
  ] as const)("refuses %s", (_name, existing, incoming) => {
    expect(isSafeToCopyOAuthIdentity(existing, incoming)).toBe(false);
  });

  it("normalizes case while preserving plus-addressing", () => {
    const existing = { email: "User+Tag@Example.com" };
    expect(isSafeToCopyOAuthIdentity(existing, { email: "user+tag@example.com" })).toBe(true);
    expect(isSafeToCopyOAuthIdentity(existing, { email: "user@example.com" })).toBe(false);
  });
});

describe("isSafeToCopyOAuthIdentity fuzz", () => {
  it("accepts matching accountIds even when email identity differs", () => {
    const rng = makeSeededRandom(0x9a_9b_9c_9d);
    const email = () => maybe(rng, randomString(rng, 32));
    for (let i = 0; i < 500; i += 1) {
      const shared = `acct-${randomString(rng, 32) || "x"}`;
      const a = { accountId: shared, email: email() };
      const b = { accountId: shared, email: email() };
      expect(isSafeToCopyOAuthIdentity(a, b)).toBe(true);
    }
  });
});

describe("shouldMirrorRefreshedOAuthCredential", () => {
  const refreshed = createOAuthRefreshCredential({ expires: 2_000, accountId: "acct-1" });
  const older = { ...refreshed, access: "old", refresh: "old-refresh", expires: 1_000 };
  const decide = (
    existing: Parameters<typeof shouldMirrorRefreshedOAuthCredential>[0]["existing"],
    incoming = refreshed,
  ) => shouldMirrorRefreshedOAuthCredential({ existing, refreshed: incoming });
  it.each([
    [undefined, true, "no-existing-credential"],
    [older, true, "incoming-fresher"],
    [createApiKeyCredential("openai", "operator-key"), false, "non-oauth-existing-credential"],
    [{ ...older, provider: "anthropic" }, false, "provider-mismatch"],
    [{ ...refreshed, expires: 3_000 }, false, "incoming-not-fresher"],
  ] as const)("returns mirror decision %j -> %s/%s", (existing, shouldMirror, reason) => {
    expect(decide(existing)).toEqual({ shouldMirror, reason });
  });
  it("rejects an out-of-range refreshed expiry", () => {
    expect(decide(older, { ...refreshed, expires: MAX_DATE_TIMESTAMP_MS + 1 })).toEqual({
      shouldMirror: false,
      reason: "incoming-not-fresher",
    });
  });
  it("refuses removing the known-account identity", () => {
    expect(decide(older, { ...refreshed, accountId: undefined })).toEqual({
      shouldMirror: false,
      reason: "identity-mismatch-or-regression",
    });
  });
});
