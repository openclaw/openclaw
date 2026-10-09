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

it.each([
  ["known same identity", { accountId: "acct-a" }, { accountId: "acct-a" }, true, true],
  ["known different identity", { accountId: "acct-a" }, { accountId: "acct-b" }, false, false],
  ["both identities unknown", {}, {}, true, false],
  ["unknown identity becomes known", {}, { accountId: "acct-a" }, true, false],
  ["known identity becomes unknown", { accountId: "acct-a" }, {}, false, false],
  [
    "provider changes",
    { accountId: "acct-a" },
    { accountId: "acct-a", provider: "anthropic" },
    false,
    false,
  ],
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
  const existing = credential({
    provider: "oidc-provider",
    access: "old-access",
    refresh: "old-refresh",
    ...oidcIdentity(),
  });
  it.each([
    ["same subject and registration", oidcIdentity(), true],
    ["changed subject", oidcIdentity({ sub: "subject-b" }), false],
    [
      "different issuer",
      {
        ...oidcIdentity({ iss: "https://other.example.test" }),
        issuer: "https://other.example.test",
      },
      false,
    ],
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
      access: "new-access",
      refresh: "new-refresh",
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
    const refreshed = { ...claimed, access: "new-access", refresh: "new-refresh" };
    expect(isSafeOAuthOwnerRefreshResult(claimed, refreshed)).toBe(true);
    expect(isSafeOAuthPostClaimSettlement(claimed, refreshed)).toBe(true);
    expect(isSafeToAdoptMainStoreOAuthIdentity(claimed, refreshed)).toBe(true);
  });

  it("settles registered identity through a secret-free fence", () => {
    const refreshed = { ...existing, access: "new-access", refresh: "new-refresh" };
    const fence = createOAuthRefreshFence({ profileId: "provider:custom", credential: existing });
    expect(isSafeOAuthPostClaimSettlement(existing, refreshed)).toBe(true);
    expect(isSafeOAuthPostClaimSettlement(fence, refreshed)).toBe(true);
    expect(isSafeToAdoptMainStoreOAuthIdentity({ ...fence, accountId: undefined }, refreshed)).toBe(
      false,
    );
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
    const profile = overlaid.profiles["openai:default"];
    expect(profile?.type).toBe("oauth");
    if (profile?.type !== "oauth") {
      throw new Error("expected overlaid OAuth profile");
    }
    expect(profile.access).toBe("access-1");
    expect(store.profiles["openai:default"]?.type).toBe("api_key");
    profile.provider = "mutated";
    overlaid.order!.openai!.push("mutated");
    expect(store.profiles["openai:default"]?.provider).toBe("openai");
    expect(store.order?.openai).toEqual(["openai:default"]);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

const minimax = credential({
  provider: "minimax-portal",
  access: "minimax-access",
  refresh: "minimax-refresh",
  expires: 1,
});
const provenanceCases: {
  name: string;
  store: RuntimeAuthProfileStore;
  overlays: RuntimeExternalOAuthProfile[];
  authoritative?: boolean;
  expectedIds?: string[];
}[] = [
  {
    name: "non-authoritative runtime overlays",
    store: {
      version: 1,
      runtimeExternalProfileIds: ["minimax:minimax-cli"],
      profiles: {
        "anthropic:claude-cli": credential({
          provider: "anthropic",
          access: "old-access",
          refresh: "old-refresh",
          expires: 1,
        }),
        "minimax:minimax-cli": minimax,
      },
    },
    overlays: [
      {
        profileId: "anthropic:claude-cli",
        credential: credential({
          provider: "anthropic",
          access: "new-access",
          refresh: "new-refresh",
          expires: 2,
        }),
      },
    ],
    expectedIds: ["anthropic:claude-cli", "minimax:minimax-cli"],
  },
  {
    name: "authoritative runtime overlays",
    store: {
      version: 1,
      runtimeExternalProfileIds: ["minimax:minimax-cli"],
      runtimeExternalProfileIdsAuthoritative: true,
      profiles: { "minimax:minimax-cli": minimax },
    },
    overlays: [],
    authoritative: true,
    expectedIds: ["minimax:minimax-cli"],
  },
  {
    name: "persisted external overlays",
    store: {
      version: 1,
      runtimePersistedProfileIds: ["openai:default"],
      runtimeCredentialSources: {
        "openai:default": { databasePath: "synthetic-owner.sqlite", provider: "openai" },
      },
      profiles: {
        "openai:default": credential({
          access: "persisted-access",
          refresh: "persisted-refresh",
          expires: 1,
        }),
      },
    },
    overlays: [
      {
        profileId: "openai:default",
        persistence: "persisted",
        credential: credential({
          access: "external-access",
          refresh: "external-refresh",
          expires: 2,
        }),
      },
    ],
  },
];
it.each(provenanceCases)(
  "preserves only valid provenance for $name",
  ({ store, overlays, authoritative, expectedIds }) => {
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
