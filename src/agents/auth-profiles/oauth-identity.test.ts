import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as facadeLoader from "../../plugin-sdk/facade-loader.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
  oidcIdentity,
} from "./credential-fixtures.test-support.js";
import { isSafeToCopyOAuthRoutingScope, resolveOAuthMirrorDecision } from "./oauth-identity.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  isSafeOAuthOwnerRefreshResult,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeOAuthPostClaimSettlement,
  overlayRuntimeExternalOAuthProfiles,
} from "./oauth-shared.js";
import type { OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

const copilot = (enterpriseUrl: string | undefined) => ({
  provider: "github-copilot",
  enterpriseUrl,
});
const email = "u@example.com";
const accountA = { accountId: "a", email };
const taggedEmail = { email: "User+Tag@Example.com" };

describe("isSafeToCopyOAuthIdentity (unified copy gate, used for mirror and adopt)", () => {
  it("preserves Copilot credentials when the shipped policy artifact is missing", () => {
    const load = vi
      .spyOn(facadeLoader, "loadBundledPluginPublicSurfaceModuleSyncCore")
      .mockImplementation(() => {
        throw new facadeLoader.MissingPublicSurfaceError("Missing Copilot policy artifact");
      });
    try {
      expect(isSafeToCopyOAuthRoutingScope(copilot("acme.ghe.com"), copilot("acme.ghe.com"))).toBe(
        false,
      );
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
    expect(isSafeToCopyOAuthRoutingScope(copilot(existing), copilot(incoming))).toBe(expected);
  });
});

describe("resolveOAuthMirrorDecision", () => {
  const refreshed = createOAuthRefreshCredential({ expires: 2_000, accountId: "acct-1" });
  const older = { ...refreshed, access: "old", refresh: "old-refresh", expires: 1_000 };
  const decide = (
    existing: Parameters<typeof resolveOAuthMirrorDecision>[0]["existing"],
    incoming = refreshed,
  ) => resolveOAuthMirrorDecision({ existing, refreshed: incoming });
  it.each([
    [undefined, "mirror"],
    [older, "mirror"],
    [createApiKeyCredential("openai", "operator-key"), "keep"],
    [{ ...older, provider: "anthropic" }, "keep"],
    [{ ...refreshed, expires: 3_000 }, "incoming-not-fresher"],
  ] as const)("returns mirror decision %j -> %s", (existing, decision) => {
    expect(decide(existing)).toBe(decision);
  });
  it("rejects an out-of-range refreshed expiry", () => {
    expect(decide(older, { ...refreshed, expires: MAX_DATE_TIMESTAMP_MS + 1 })).toBe(
      "incoming-not-fresher",
    );
  });
  it("refuses removing the known-account identity", () => {
    expect(decide(older, { ...refreshed, accountId: undefined })).toBe(
      "identity-mismatch-or-regression",
    );
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
  ["non-overlapping fields", { accountId: "x" }, { email }, false, false],
  ["account case beats email", accountA, { ...accountA, accountId: "A" }, false, false],
  ["email mismatch", { email: "a@example.com" }, { email: "b@example.com" }, false, false],
  ["email case", taggedEmail, { email: "user+tag@example.com" }, true, true],
  ["plus addressing", taggedEmail, { email: "user@example.com" }, false, false],
  ["matching account overrides email", accountA, { ...accountA, email: "b" }, true, true],
  [
    "cross-tenant adoption",
    copilot("acme.ghe.com"),
    { ...copilot("other.ghe.com"), accountId: "acct-main" },
    false,
    false,
  ],
] as const)(
  "applies exact-owner and different-owner rules for %s",
  (_name, claimed, refreshed, exactOwner, differentOwner) => {
    expect([
      isSafeOAuthOwnerRefreshResult(credential(claimed), credential(refreshed)),
      isSafeOAuthPostClaimSettlement(credential(claimed), credential(refreshed)),
    ]).toEqual([exactOwner, differentOwner]);
  },
);

describe("OIDC registered identity", () => {
  const existing = credential({ provider: "oidc-provider", ...oidcIdentity() });
  it.each([
    ["same subject and registration", {}, true],
    ["changed subject", { accountId: "subject-b" }, false],
    ["different issuer", { issuer: "https://other.example.test" }, false],
    ["different client", { clientId: "client-other" }, false],
    ["missing bound account identity", { accountId: undefined }, false],
    ["secret-free fence identity", { idToken: undefined }, true],
    ["removed registration", { issuer: undefined, clientId: undefined }, false],
  ] as const)("gates adoption, mirroring and settlement for %s", (_name, metadata, safe) => {
    const claimed = { ...existing, email: "same@example.test" };
    const incoming = {
      ...claimed,
      expires: claimed.expires + 600_000,
      ...metadata,
    };
    expect({
      main: isSafeToAdoptMainStoreOAuthIdentity(claimed, incoming),
      bootstrap: isSafeToAdoptBootstrapOAuthIdentity(claimed, incoming),
      mirror: resolveOAuthMirrorDecision({ existing: claimed, refreshed: incoming }) === "mirror",
      owner: isSafeOAuthOwnerRefreshResult(claimed, incoming),
      settlement: isSafeOAuthPostClaimSettlement(claimed, incoming),
    }).toEqual({ main: safe, bootstrap: safe, mirror: safe, owner: safe, settlement: safe });
  });

  it.each([
    { issuer: "https://auth.x.ai", idToken: "provider-managed-id-token" },
    { clientId: "chutes-client" },
  ])("preserves provider account identity without an OIDC registration pair: %j", (metadata) => {
    const claimed = credential({ provider: "oidc-provider", accountId: "account-a", ...metadata });
    const refreshed = { ...claimed, access: "rotated-access", refresh: "rotated-refresh" };
    expect(isSafeOAuthOwnerRefreshResult(claimed, refreshed)).toBe(true);
    expect(isSafeOAuthPostClaimSettlement(claimed, refreshed)).toBe(true);
    expect(isSafeToAdoptMainStoreOAuthIdentity(claimed, refreshed)).toBe(true);
  });

  it("settles registered identity through a secret-free fence", () => {
    const refreshed = { ...existing, access: "new-access", refresh: "new-refresh" };
    const fence = createOAuthRefreshFence({ profileId: "provider:custom", credential: existing });
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
    };
    if (persisted) {
      store.runtimePersistedProfileIds = [id];
      store.runtimeCredentialSources = {
        [id]: { databasePath: "synthetic-owner.sqlite", provider: "openai" },
      };
    } else {
      store.runtimeExternalProfileIds = [priorId];
      store.runtimeExternalProfileIdsAuthoritative = authoritative;
    }
    const overlaid: RuntimeAuthProfileStore = overlayRuntimeExternalOAuthProfiles(
      store,
      authoritative
        ? []
        : [{ profileId: id, credential: oauth, persistence: persisted ? "persisted" : undefined }],
      { runtimeExternalProfileIdsAuthoritative: authoritative },
    );
    expect(overlaid.runtimeExternalProfileIds).toEqual(
      persisted ? undefined : authoritative ? [priorId] : [priorId, id],
    );
    expect(overlaid.runtimeExternalProfileIdsAuthoritative).toBe(authoritative);
    if (persisted) {
      expect(overlaid.runtimePersistedProfileIds).toBeUndefined();
      expect(overlaid.runtimeCredentialSources).toEqual({});
    }
    if (!authoritative) {
      expect(overlaid.profiles[id]).toMatchObject({ type: "oauth", access: oauth.access });
    }
    expect(store.profiles[id]).toEqual(
      persisted ? oauth : createApiKeyCredential("openai", "sk-test"),
    );
  },
);
