import { expectDefined } from "@openclaw/normalization-core/expect";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as facadeLoader from "../../plugin-sdk/facade-loader.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
  oidcIdentity,
} from "./credential-fixtures.test-support.js";
import {
  isSafeToCopyOAuthRoutingScope,
  isSafeToCopyOAuthIdentity,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  isSafeOAuthOwnerRefreshResult,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeOAuthPostClaimSettlement,
  overlayRuntimeExternalOAuthProfiles,
} from "./oauth-shared.js";
import { makeSeededRandom, maybe, randomAsciiString as randomString } from "./oauth-test-utils.js";
import type { OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

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

const credential = (overrides: Partial<OAuthCredential> = {}) =>
  createOAuthRefreshCredential({ expires: Date.now() + 600_000, ...overrides });
const known = { accountId: "acct-a" };

it.each([
  ["known same identity", known, known, true, true],
  ["known different identity", known, { accountId: "acct-b" }, false, false],
  ["both identities unknown", {}, {}, true, false],
  ["unknown identity becomes known", {}, known, true, false],
  ["known identity becomes unknown", known, {}, false, false],
  ["provider changes", known, { ...known, provider: "anthropic" }, false, false],
] as const)(
  "applies exact-owner and different-owner rules for %s",
  (_name, claimed, refreshed, exactOwner, differentOwner) => {
    expect(isSafeOAuthOwnerRefreshResult(credential(claimed), credential(refreshed))).toBe(
      exactOwner,
    );
    expect(isSafeOAuthPostClaimSettlement(credential(claimed), credential(refreshed))).toBe(
      differentOwner,
    );
  },
);

describe("OIDC registered identity", () => {
  const existing = credential({ provider: "oidc-provider", ...oidcIdentity() });
  const otherIssuer = "https://other.example.test";
  it.each([
    ["same subject and registration", oidcIdentity(), true],
    ["changed subject", oidcIdentity({ sub: "subject-b" }), false],
    ["different issuer", { ...oidcIdentity({ iss: otherIssuer }), issuer: otherIssuer }, false],
    [
      "different client",
      { ...oidcIdentity({ aud: "client-other" }), clientId: "client-other" },
      false,
    ],
    ["missing bound account identity", { accountId: undefined }, false],
    ["secret-free fence identity", { idToken: undefined }, true],
    ["removed registration", { issuer: undefined, clientId: undefined }, false],
  ] as const)("gates adoption, mirroring and settlement for %s", (_name, metadata, safe) => {
    // Equal email labels must not substitute for a registered OIDC identity.
    const claimed = { ...existing, email: "same@example.test" };
    const incoming = {
      ...claimed,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: claimed.expires + 600_000,
      ...metadata,
    };
    expect(isSafeToAdoptMainStoreOAuthIdentity(claimed, incoming)).toBe(safe);
    expect(isSafeToAdoptBootstrapOAuthIdentity(claimed, incoming)).toBe(safe);
    expect(
      shouldMirrorRefreshedOAuthCredential({ existing: claimed, refreshed: incoming }).shouldMirror,
    ).toBe(safe);
    expect(isSafeOAuthOwnerRefreshResult(claimed, incoming)).toBe(safe);
    expect(isSafeOAuthPostClaimSettlement(claimed, incoming)).toBe(safe);
  });

  it.each([
    { issuer: "https://auth.x.ai", idToken: "provider-managed-id-token" },
    { clientId: "chutes-client" },
  ])("preserves provider account identity without an OIDC registration pair: %j", (metadata) => {
    const claimed = {
      ...existing,
      issuer: undefined,
      clientId: undefined,
      idToken: undefined,
      accountId: "account-a",
      ...metadata,
    };
    const refreshed = { ...claimed, access: "rotated-access", refresh: "rotated-refresh" };
    expect(isSafeOAuthOwnerRefreshResult(claimed, refreshed)).toBe(true);
    expect(isSafeOAuthPostClaimSettlement(claimed, refreshed)).toBe(true);
    expect(isSafeToAdoptMainStoreOAuthIdentity(claimed, refreshed)).toBe(true);
  });

  it("settles registered identity through a secret-free fence", () => {
    const refreshed = { ...existing, access: "new-access", refresh: "new-refresh" };
    const fence = createOAuthRefreshFence({ profileId: "provider:custom", credential: existing });
    expect(isSafeOAuthPostClaimSettlement(existing, refreshed)).toBe(true);
    expect(isSafeOAuthPostClaimSettlement(fence, refreshed)).toBe(true);
    const anonymous = { ...fence, accountId: undefined };
    expect(isSafeToAdoptMainStoreOAuthIdentity(anonymous, refreshed)).toBe(false);
  });
});

it.each(["runtime", "authoritative", "persisted"] as const)(
  "preserves only valid provenance for %s overlays",
  (mode) => {
    const persisted = mode === "persisted";
    const authoritative = mode === "authoritative" ? true : undefined;
    const id = "openai:default",
      priorId = "minimax:minimax-cli";
    const oauth = credential();
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: {
        [id]: persisted ? { ...oauth } : createApiKeyCredential("openai", "sk-test"),
        [priorId]: credential({ provider: "minimax-portal" }),
      },
      order: { openai: [id] },
      ...(persisted
        ? {
            runtimePersistedProfileIds: [id],
            runtimeCredentialSources: {
              [id]: { databasePath: "synthetic-owner.sqlite", provider: "openai" },
            },
          }
        : {
            runtimeExternalProfileIds: [priorId],
            runtimeExternalProfileIdsAuthoritative: authoritative,
          }),
    };
    const overlays = authoritative
      ? []
      : [
          {
            profileId: id,
            credential: oauth,
            ...(persisted ? { persistence: "persisted" as const } : {}),
          },
        ];
    const overlaid: RuntimeAuthProfileStore = overlayRuntimeExternalOAuthProfiles(store, overlays, {
      runtimeExternalProfileIdsAuthoritative: authoritative,
    });
    expect(overlaid.runtimeExternalProfileIds).toEqual(
      persisted ? undefined : authoritative ? [priorId] : [priorId, id],
    );
    expect(overlaid.runtimeExternalProfileIdsAuthoritative).toBe(authoritative);
    if (persisted) {
      expect(overlaid.runtimePersistedProfileIds).toBeUndefined();
      expect(overlaid.runtimeCredentialSources).toEqual({});
    }
    const profile = expectDefined(overlaid.profiles[id], "overlaid profile");
    if (!authoritative) {
      expect(profile).toMatchObject({ type: "oauth", access: oauth.access });
    }
    profile.provider = "mutated";
    overlaid.order!.openai!.push("mutated");
    expect(store.profiles[id]).toMatchObject({
      type: persisted ? "oauth" : "api_key",
      provider: "openai",
    });
    expect(store.order?.openai).toEqual([id]);
  },
);
