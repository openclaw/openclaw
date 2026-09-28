import { describe, expect, it } from "vitest";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import type { OAuthCredential } from "./types.js";

it.each([
  { tenant: "other.ghe.com", expected: false },
  { tenant: "https://acme.ghe.com/", expected: true },
])("gates shared refresh-generation ownership on tenant scope: $tenant", ({ tenant, expected }) => {
  const local: OAuthCredential = {
    type: "oauth",
    provider: "github-copilot",
    enterpriseUrl: "acme.ghe.com",
    access: "access-token",
    refresh: "shared-refresh-generation",
    expires: Date.now(),
  };
  expect(
    shouldUseMainOwnerForLocalOAuthCredential({
      profileId: "github-copilot:default",
      local,
      main: {
        ...local,
        enterpriseUrl: tenant,
        expires: local.expires + 60_000,
        accountId: "acct-main",
      },
    }),
  ).toBe(expected);
});

describe("Copilot persisted public-scope metadata", () => {
  it.each([
    { name: "absent", enterpriseUrl: undefined, expected: true },
    { name: "empty", enterpriseUrl: "", expected: true },
    { name: "spaces only", enterpriseUrl: "  ", expected: false },
    { name: "tabs and newlines only", enterpriseUrl: "\t\n", expected: false },
  ])(
    "aligns copy, adoption and copied-generation ownership for $name metadata",
    ({ enterpriseUrl, expected }) => {
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "github-copilot",
        enterpriseUrl,
        access: "access-token",
        refresh: "shared-refresh-generation",
        expires: 2_000,
      };
      const publicCredential = { ...credential, enterpriseUrl: "https://github.com/" };
      // Check both directions, including the identical-refresh ownership shortcut.
      for (const [existing, incoming] of [
        [credential, publicCredential],
        [publicCredential, credential],
      ] as const) {
        expect.soft(isSafeToCopyOAuthIdentity(existing, incoming)).toBe(expected);
        expect.soft(isSafeToAdoptMainStoreOAuthIdentity(existing, incoming)).toBe(expected);
        expect
          .soft(
            shouldUseMainOwnerForLocalOAuthCredential({
              profileId: "github-copilot:default",
              local: existing,
              main: incoming,
            }),
          )
          .toBe(expected);
      }
    },
  );
});
