import { expect, it } from "vitest";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import type { OAuthCredential } from "./types.js";

const credential: OAuthCredential = {
  type: "oauth",
  provider: "github-copilot",
  access: "access-token",
  refresh: "shared-refresh-generation",
  expires: 2_000,
};

it("rejects whitespace-only public scope in both identity directions", () => {
  const invalid = { ...credential, enterpriseUrl: "  " };
  const publicCredential = { ...credential, enterpriseUrl: "https://github.com/" };
  for (const [existing, incoming] of [
    [invalid, publicCredential],
    [publicCredential, invalid],
  ] as const) {
    expect(isSafeToCopyOAuthIdentity(existing, incoming)).toBe(false);
    expect(isSafeToAdoptMainStoreOAuthIdentity(existing, incoming)).toBe(false);
    expect(
      shouldUseMainOwnerForLocalOAuthCredential({
        profileId: "github-copilot:default",
        local: existing,
        main: incoming,
      }),
    ).toBe(false);
  }
});
