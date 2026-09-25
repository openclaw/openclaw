import { describe, expect, it } from "vitest";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import type { OAuthCredential } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

describe("Copilot tenant identity-less adoption", () => {
  it.each([
    ["different enterprise tenant", "acme.ghe.com", "other.ghe.com", false],
    ["public versus enterprise tenant", undefined, "acme.ghe.com", false],
    ["public URL spellings", undefined, "https://github.com/", true],
    ["same enterprise tenant URL spelling", "HTTPS://ACME.GHE.COM/", "acme.ghe.com", true],
  ])(
    "applies provider routing scope before identity-less adoption: %s",
    (_name, existingDomain, incomingDomain, expected) => {
      expect(
        isSafeToAdoptMainStoreOAuthIdentity(
          createCredential({ provider: "github-copilot", enterpriseUrl: existingDomain }),
          createCredential({
            provider: "github-copilot",
            enterpriseUrl: incomingDomain,
            accountId: "acct-main",
          }),
        ),
      ).toBe(expected);
    },
  );
});

describe("shouldUseMainOwnerForLocalOAuthCredential", () => {
  it("does not transfer ownership across GitHub Copilot tenants", () => {
    expect(
      shouldUseMainOwnerForLocalOAuthCredential({
        profileId: "github-copilot:default",
        local: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "acme.ghe.com",
          refresh: "shared-refresh-generation",
          expires: Date.now(),
        }),
        main: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "other.ghe.com",
          refresh: "shared-refresh-generation",
          expires: Date.now() + 60_000,
          accountId: "acct-main",
        }),
      }),
    ).toBe(false);
  });

  it("keeps ownership transfer for the same tenant when main is fresher", () => {
    expect(
      shouldUseMainOwnerForLocalOAuthCredential({
        profileId: "github-copilot:default",
        local: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "acme.ghe.com",
          refresh: "shared-refresh-generation",
          expires: Date.now(),
        }),
        main: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "https://acme.ghe.com/",
          refresh: "shared-refresh-generation",
          expires: Date.now() + 60_000,
          accountId: "acct-main",
        }),
      }),
    ).toBe(true);
  });
});
