import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
  oidcIdentity,
} from "./credential-fixtures.test-support.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  isSafeOAuthOwnerRefreshResult,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeOAuthPostClaimSettlement,
  overlayRuntimeExternalOAuthProfiles,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

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

it("isolates runtime OAuth overlays without structuredClone", () => {
  const spy = vi.spyOn(globalThis, "structuredClone");
  const store: AuthProfileStore = {
    version: 1,
    profiles: { "openai:default": createApiKeyCredential("openai", "sk-test") },
    order: { openai: ["openai:default"] },
  };
  try {
    const overlaid = overlayRuntimeExternalOAuthProfiles(store, [
      {
        profileId: "openai:default",
        credential: credential({ access: "access-1", refresh: "refresh-1" }),
      },
    ]);
    const profile = expectDefined(overlaid.profiles["openai:default"], "overlaid profile");
    expect(profile).toMatchObject({ type: "oauth", access: "access-1" });
    profile.provider = "mutated";
    overlaid.order!.openai!.push("mutated");
    expect(store.profiles["openai:default"]).toMatchObject({ type: "api_key", provider: "openai" });
    expect(store.order?.openai).toEqual(["openai:default"]);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

const minimaxId = "minimax:minimax-cli",
  anthropicId = "anthropic:claude-cli",
  openaiId = "openai:default";
const minimax = credential({ provider: "minimax-portal" });
const anthropic = credential({ provider: "anthropic" });
const openai = credential();
const runtime: RuntimeAuthProfileStore = {
  version: 1,
  profiles: { [minimaxId]: minimax },
  runtimeExternalProfileIds: [minimaxId],
};
it.each<
  [string, RuntimeAuthProfileStore, RuntimeExternalOAuthProfile[], string[] | undefined, boolean?]
>([
  [
    "non-authoritative runtime overlays",
    { ...runtime, profiles: { ...runtime.profiles, [anthropicId]: anthropic } },
    [{ profileId: anthropicId, credential: anthropic }],
    [anthropicId, minimaxId],
  ],
  [
    "authoritative runtime overlays",
    { ...runtime, runtimeExternalProfileIdsAuthoritative: true },
    [],
    [minimaxId],
    true,
  ],
  [
    "persisted external overlays",
    {
      version: 1,
      profiles: { [openaiId]: openai },
      runtimePersistedProfileIds: [openaiId],
      runtimeCredentialSources: {
        [openaiId]: { databasePath: "synthetic-owner.sqlite", provider: "openai" },
      },
    },
    [{ profileId: openaiId, persistence: "persisted", credential: openai }],
    undefined,
  ],
])(
  "preserves only valid provenance for %s",
  (_name, store, overlays, expectedIds, authoritative) => {
    const overlaid: RuntimeAuthProfileStore = overlayRuntimeExternalOAuthProfiles(store, overlays, {
      runtimeExternalProfileIdsAuthoritative: authoritative,
    });
    expect(overlaid.runtimeExternalProfileIds).toEqual(expectedIds);
    expect(overlaid.runtimeExternalProfileIdsAuthoritative).toBe(authoritative);
    if (store.runtimePersistedProfileIds) {
      expect(overlaid.runtimePersistedProfileIds).toBeUndefined();
      expect(overlaid.runtimeCredentialSources).toEqual({});
    }
  },
);
