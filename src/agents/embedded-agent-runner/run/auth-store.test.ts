import { describe, expect, it } from "vitest";
import { createScopedAuthProfileStore, resolveAttemptDispatchApiKey } from "./auth-store.js";

const apiKeyInfo = {
  apiKey: "source-token",
  source: "profile:test",
  mode: "oauth" as const,
};

const runtimeAuthState = {
  sourceApiKey: "source-token",
  apiKey: "runtime-token",
  authMode: "oauth",
};

describe("resolveAttemptDispatchApiKey", () => {
  it.each([
    ["keeps runtime auth in the core transport", runtimeAuthState, false, undefined],
    ["forwards source auth to the transport owner", runtimeAuthState, true, "source-token"],
    ["keeps direct credentials without runtime auth", null, false, "source-token"],
  ] as const)("%s", (_name, runtimeAuth, pluginHarnessOwnsTransport, expected) => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState: runtimeAuth,
        pluginHarnessOwnsTransport,
      }),
    ).toBe(expected);
  });
});

describe("createScopedAuthProfileStore", () => {
  const oauth = (access: string, refresh: string) => ({
    type: "oauth" as const,
    provider: "openai",
    access,
    refresh,
    expires: Date.now() + 60_000,
  });
  const store = {
    version: 1 as const,
    runtimePersistedProfileIds: ["anthropic:work", "openai:other", "openai:work"],
    runtimeExternalProfileIds: ["openai:external", "xai:work"],
    runtimeExternalProfileIdsAuthoritative: true,
    profiles: {
      "openai:work": oauth("access", "refresh"),
      "openai:other": oauth("other-access", "other-refresh"),
      "openai:external": oauth("external-access", "external-refresh"),
      "anthropic:work": {
        type: "api_key" as const,
        provider: "anthropic",
        key: "sk-ant",
      },
      "xai:work": {
        type: "api_key" as const,
        provider: "xai",
        key: "xai-key",
      },
    },
  };

  it("forwards only the selected persisted profile to a transport-owning harness", () => {
    expect(createScopedAuthProfileStore(store, ["openai:work"])).toEqual({
      version: 1,
      profiles: { "openai:work": store.profiles["openai:work"] },
      runtimePersistedProfileIds: ["openai:work"],
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("returns an empty store when no requested profile exists", () => {
    expect(createScopedAuthProfileStore(store, ["openai:missing"])).toEqual({
      version: 1,
      profiles: {},
    });
  });
});
