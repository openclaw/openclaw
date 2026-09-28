import { expect, it } from "vitest";
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
