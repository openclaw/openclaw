import { expect, it } from "vitest";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import {
  buildPortableAuthProfileStoreForAgentCopy,
  resolveAuthProfilePortability,
} from "./portability.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

const oauth = createOAuthRefreshCredential();
const key = createApiKeyCredential("openai", "sk-test");
const token = { type: "token", provider: "github-copilot", token: "gho-test" } as const;

it("copies static credentials and their order, not OAuth or usage metadata", () => {
  const store: AuthProfileStore = {
    version: 1,
    profiles: { key, token, oauth },
    order: { openai: ["oauth", "key"], "github-copilot": ["token"] },
    lastGood: { openai: "key" },
    usageStats: { key: { lastUsed: 1_000 } },
  };
  expect(buildPortableAuthProfileStoreForAgentCopy(store)).toEqual({
    copiedProfileIds: ["key", "token"],
    skippedProfileIds: ["oauth"],
    store: {
      version: 1,
      profiles: { key, token },
      order: { openai: ["key"], "github-copilot": ["token"] },
    },
  });
});

it.each([
  [
    "provider OAuth opt-in",
    { ...oauth, provider: "demo", copyToAgents: true },
    true,
    "oauth-provider-opted-in",
  ],
  ["static opt-out", { ...key, copyToAgents: false }, false, "credential-opted-out"],
] as const)("honors %s", (_name, credential, portable, reason) => {
  expect(resolveAuthProfilePortability(credential)).toEqual({ portable, reason });
});

it("does not copy empty OAuth profiles even when they opt in", () => {
  const credential = {
    type: "oauth",
    provider: "openai",
    expires: Date.now() + 60_000,
    copyToAgents: true,
    oauthRef: {
      source: "openclaw-credentials",
      provider: "openai",
      id: "0123456789abcdef0123456789abcdef",
    },
  } as unknown as AuthProfileCredential;
  expect(resolveAuthProfilePortability(credential)).toEqual({
    portable: false,
    reason: "non-portable-oauth-refresh-token",
  });
});
