/**
 * Tests shared OAuth credential identity and overlay policy.
 * Covers runtime-only provenance and cloned store isolation.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  oauthCred,
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
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

describe("OAuth refresh identity policy", () => {
  const credential = (
    identity: Pick<OAuthCredential, "accountId" | "email"> = {},
    provider = "openai",
  ): OAuthCredential => ({
    type: "oauth",
    provider,
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 600_000,
    ...identity,
  });

  it.each([
    {
      name: "known same identity",
      claimed: credential({ accountId: "acct-a" }),
      refreshed: credential({ accountId: "acct-a" }),
      exactOwner: true,
      differentOwner: true,
    },
    {
      name: "known different identity",
      claimed: credential({ accountId: "acct-a" }),
      refreshed: credential({ accountId: "acct-b" }),
      exactOwner: false,
      differentOwner: false,
    },
    {
      name: "both identities unknown",
      claimed: credential(),
      refreshed: credential(),
      exactOwner: true,
      differentOwner: false,
    },
    {
      name: "unknown identity becomes known",
      claimed: credential(),
      refreshed: credential({ accountId: "acct-a" }),
      exactOwner: true,
      differentOwner: false,
    },
    {
      name: "known identity becomes unknown",
      claimed: credential({ accountId: "acct-a" }),
      refreshed: credential(),
      exactOwner: false,
      differentOwner: false,
    },
    {
      name: "provider changes",
      claimed: credential({ accountId: "acct-a" }),
      refreshed: credential({ accountId: "acct-a" }, "anthropic"),
      exactOwner: false,
      differentOwner: false,
    },
  ])(
    "applies exact-owner and different-owner rules for $name",
    ({ claimed, refreshed, exactOwner, differentOwner }) => {
      expect(isSafeOAuthOwnerRefreshResult(claimed, refreshed)).toBe(exactOwner);
      expect(isSafeOAuthPostClaimSettlement(claimed, refreshed)).toBe(differentOwner);
    },
  );
});

describe("OIDC registered identity", () => {
  const existing: OAuthCredential = {
    type: "oauth",
    provider: "oidc-provider",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() + 600_000,
    ...oidcIdentity(),
  };

  it.each([
    { name: "same subject and registration", metadata: oidcIdentity(), safe: true },
    { name: "changed subject", metadata: oidcIdentity({ sub: "subject-b" }), safe: false },
    {
      name: "different issuer",
      metadata: {
        ...oidcIdentity({ iss: "https://other.example.test" }),
        issuer: "https://other.example.test",
      },
      safe: false,
    },
    {
      name: "different client",
      metadata: { ...oidcIdentity({ aud: "client-other" }), clientId: "client-other" },
      safe: false,
    },
    { name: "missing bound account identity", metadata: { accountId: undefined }, safe: false },
    { name: "secret-free fence identity", metadata: { idToken: undefined }, safe: true },
    {
      name: "removed registration",
      metadata: { issuer: undefined, clientId: undefined },
      safe: false,
    },
  ])("gates adoption, mirroring and settlement for $name", ({ metadata, safe }) => {
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

describe("overlayRuntimeExternalOAuthProfiles", () => {
  it("isolates runtime OAuth overlays without structuredClone", () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": createApiKeyCredential("openai", "sk-test"),
      },
      order: {
        openai: ["openai:default"],
      },
    };

    try {
      const overlaid = overlayRuntimeExternalOAuthProfiles(store, [
        {
          profileId: "openai:default",
          credential: oauthCred({
            provider: "openai",
            access: "access-1",
            refresh: "refresh-1",
            expires: Date.now() + 60_000,
          }),
        },
      ]);

      const overlaidCodexProfile = overlaid.profiles["openai:default"];
      expect(overlaidCodexProfile?.type).toBe("oauth");
      if (overlaidCodexProfile?.type !== "oauth") {
        throw new Error("expected overlaid Codex OAuth profile");
      }
      expect(overlaidCodexProfile.access).toBe("access-1");
      expect(store.profiles["openai:default"]?.type).toBe("api_key");

      expectDefined(
        overlaid.profiles["openai:default"],
        'overlaid.profiles["openai:default"] test invariant',
      ).provider = "mutated";
      expectDefined(overlaid.order?.openai, "OpenAI profile order").push("mutated");

      expect(store.profiles["openai:default"]?.provider).toBe("openai");
      expect(store.order?.openai).toEqual(["openai:default"]);
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
    }
  });

  it("preserves existing runtime-only provenance for non-authoritative overlays", () => {
    const store: AuthProfileStore = {
      version: 1,
      runtimeExternalProfileIds: ["minimax:minimax-cli"],
      profiles: {
        "anthropic:claude-cli": oauthCred({
          provider: "anthropic",
          access: "old-access",
          refresh: "old-refresh",
          expires: 1,
        }),
        "minimax:minimax-cli": oauthCred({
          provider: "minimax-portal",
          access: "minimax-access",
          refresh: "minimax-refresh",
          expires: 1,
        }),
      },
    };

    const overlaid = overlayRuntimeExternalOAuthProfiles(store, [
      {
        profileId: "anthropic:claude-cli",
        credential: oauthCred({
          provider: "anthropic",
          access: "new-access",
          refresh: "new-refresh",
          expires: 2,
        }),
      },
    ]);

    expect(overlaid.runtimeExternalProfileIds).toEqual([
      "anthropic:claude-cli",
      "minimax:minimax-cli",
    ]);
  });

  it("preserves existing runtime-only provenance for authoritative overlays", () => {
    const store: AuthProfileStore = {
      version: 1,
      runtimeExternalProfileIds: ["minimax:minimax-cli"],
      runtimeExternalProfileIdsAuthoritative: true,
      profiles: {
        "minimax:minimax-cli": oauthCred({
          provider: "minimax-portal",
          access: "minimax-access",
          refresh: "minimax-refresh",
          expires: 1,
        }),
      },
    };

    const overlaid = overlayRuntimeExternalOAuthProfiles(store, [], {
      runtimeExternalProfileIdsAuthoritative: true,
    });

    expect(overlaid.runtimeExternalProfileIds).toEqual(["minimax:minimax-cli"]);
    expect(overlaid.runtimeExternalProfileIdsAuthoritative).toBe(true);
  });

  it("removes persisted provenance for every externally overlaid profile", () => {
    const store: RuntimeAuthProfileStore = {
      version: 1,
      runtimePersistedProfileIds: ["openai:default"],
      runtimeCredentialSources: {
        "openai:default": { databasePath: "synthetic-owner.sqlite", provider: "openai" },
      },
      profiles: {
        "openai:default": oauthCred({
          provider: "openai",
          access: "persisted-access",
          refresh: "persisted-refresh",
          expires: 1,
        }),
      },
    };

    const overlaid: RuntimeAuthProfileStore = overlayRuntimeExternalOAuthProfiles(store, [
      {
        profileId: "openai:default",
        persistence: "persisted",
        credential: oauthCred({
          provider: "openai",
          access: "external-access",
          refresh: "external-refresh",
          expires: 2,
        }),
      },
    ]);

    expect(overlaid.runtimePersistedProfileIds).toBeUndefined();
    expect(overlaid.runtimeCredentialSources).toEqual({});
  });
});
