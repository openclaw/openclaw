import { describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { __testing, coercePersistedAuthProfileStore } from "./persisted.js";

describe("persisted auth profile boundary", () => {
  it("reads an existing macOS oauth profile master key before file fallback", () => {
    const calls: string[] = [];

    const seed = __testing.resolveOAuthProfileSecretKeySeedWithDeps(
      { create: true },
      {
        env: {},
        platform: "darwin",
        readMacKeychain: () => {
          calls.push("readMacKeychain");
          return "existing-keychain-key";
        },
        readFile: () => {
          calls.push("readFile");
          return "file-key";
        },
        createFile: () => {
          calls.push("createFile");
          return "created-file-key";
        },
      },
    );

    expect(seed).toBe("existing-keychain-key");
    expect(calls).toEqual(["readMacKeychain"]);
  });

  it("creates the fallback oauth profile key file when macOS Keychain has no entry", () => {
    const calls: string[] = [];

    const seed = __testing.resolveOAuthProfileSecretKeySeedWithDeps(
      { create: true },
      {
        env: {},
        platform: "darwin",
        readMacKeychain: () => {
          calls.push("readMacKeychain");
          return undefined;
        },
        readFile: () => {
          calls.push("readFile");
          return undefined;
        },
        createFile: () => {
          calls.push("createFile");
          return "created-file-key";
        },
      },
    );

    expect(seed).toBe("created-file-key");
    expect(calls).toEqual(["readMacKeychain", "readFile", "createFile"]);
  });

  it("skips macOS Keychain reads under Vitest and on non-macOS platforms", () => {
    expect(
      __testing.shouldReadMacKeychainForOAuthProfileSecrets({
        env: {},
        platform: "darwin",
      }),
    ).toBe(true);
    expect(
      __testing.shouldReadMacKeychainForOAuthProfileSecrets({
        env: { VITEST: "true" },
        platform: "darwin",
      }),
    ).toBe(false);
    expect(
      __testing.shouldReadMacKeychainForOAuthProfileSecrets({
        env: { VITEST_WORKER_ID: "1" },
        platform: "darwin",
      }),
    ).toBe(false);
    expect(
      __testing.shouldReadMacKeychainForOAuthProfileSecrets({
        env: {},
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("normalizes malformed persisted credentials and state before runtime use", () => {
    const store = coercePersistedAuthProfileStore({
      version: "not-a-version",
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: " OpenAI ",
          key: 42,
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123", bad: 123 },
          copyToAgents: "yes",
          email: ["wrong"],
          displayName: "Work",
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          token: ["wrong"],
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: "tomorrow",
        },
        "codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: ["wrong"],
          refresh: "refresh-token",
          expires: "later",
          oauthRef: {
            source: "openclaw-credentials",
            provider: "openai-codex",
            id: "not-a-secret-id",
          },
        },
        "broken:array": [],
      },
      order: {
        OpenAI: [" openai:default ", 5, ""],
        minimax: "wrong",
      },
      lastGood: {
        OpenAI: " openai:default ",
        minimax: 5,
      },
      usageStats: {
        "openai:default": {
          cooldownUntil: "later",
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: {
            billing: 2,
            nope: 4,
          },
        },
        "minimax:default": "wrong",
      },
    });

    expect(store).toMatchObject({
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123" },
          displayName: "Work",
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: 0,
        },
        "codex:default": {
          type: "oauth",
          provider: "openai-codex",
          refresh: "refresh-token",
          expires: 0,
        },
      },
      order: {
        openai: ["openai:default"],
      },
      lastGood: {
        openai: "openai:default",
      },
      usageStats: {
        "openai:default": {
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: { billing: 2 },
        },
      },
    });
    expect(store?.profiles["broken:array"]).toBeUndefined();
    expect(store?.profiles["openai:default"]).not.toHaveProperty("key");
    expect(store?.profiles["openai:default"]).not.toHaveProperty("copyToAgents");
    expect(store?.profiles["codex:default"]).not.toHaveProperty("oauthRef");
  });
});
