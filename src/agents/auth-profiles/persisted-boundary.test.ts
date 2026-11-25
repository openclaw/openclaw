import { describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  oauthCred,
  createApiKeyCredential as apiKey,
  oidcIdentity,
} from "./credential-fixtures.test-support.js";
import { applyLegacyAuthStore, coerceLegacyAuthStore } from "./legacy-flat-credential.js";
import { resolveAuthProfileOrder } from "./order.js";
import {
  buildPersistedAuthProfileSecretsStore,
  coercePersistedAuthProfileStore,
  mergeAuthProfileStores,
} from "./persisted.js";
import { buildPersistedAuthProfileState, coerceAuthProfileState } from "./state.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

function oauth(access: string, refresh: string, expires: number, provider = "openai") {
  return oauthCred({ provider, access, refresh, expires });
}

function makeStore(
  profiles: AuthProfileStore["profiles"],
  extra: Omit<RuntimeAuthProfileStore, "version" | "profiles"> = {},
): RuntimeAuthProfileStore {
  return { version: AUTH_STORE_VERSION, profiles, ...extra };
}

describe("persisted auth profile boundary", () => {
  it.each([
    { mode: "api_key", provider: "example", apiKey: "synthetic-key" },
    { type: "api_key", provider: "example", key: { source: "env", id: "SYNTHETIC_KEY" } },
    { type: "token", provider: "example", token: { source: "env", id: "SYNTHETIC_TOKEN" } },
  ])(
    "refuses unmigrated credential fields before publishing a partial store ($type/$mode)",
    (credential) => {
      const raw = {
        version: 1,
        profiles: {
          "example:old": credential,
          "example:current": apiKey("example", "synthetic-current-key"),
        },
      };
      const original = structuredClone(raw);
      expect(() => coercePersistedAuthProfileStore(raw)).toThrow("openclaw doctor --fix");
      expect(raw).toEqual(original);
    },
  );

  it("normalizes dead-account classification with permanent-auth reason", () => {
    const state: Pick<AuthProfileStore, "usageStats"> = {
      usageStats: {
        "openai:default": {
          cooldownUntil: 1_900_000_000_000,
          cooldownReason: "auth_permanent",
          cooldownClassification: "wham_account_dead",
        },
      },
    };
    const normalizedStats = [
      coerceAuthProfileState(state).usageStats?.["openai:default"],
      buildPersistedAuthProfileState(state)?.usageStats?.["openai:default"],
    ];

    for (const stats of normalizedStats) {
      expect(stats).toMatchObject({
        cooldownReason: "auth_permanent",
        cooldownClassification: "wham_account_dead",
      });
    }
  });

  it("normalizes malformed canonical credentials and state before runtime use", () => {
    const expected = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123" },
          displayName: "Work",
        },
        "openai:legacy-api-key": { type: "api_key", provider: "openai", key: "legacy-openai-key" },
        "openai:legacy-malformed-ref": {
          type: "api_key",
          provider: "openai",
          key: "legacy-fallback-key",
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: 0,
        },
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          refresh: "refresh-token",
          expires: 0,
        },
        "xai:oauth": {
          type: "oauth",
          provider: "xai",
          access: "synthetic-xai-access",
          refresh: "synthetic-xai-refresh",
          expires: 1_900_000_000_000,
          tokenEndpoint: "https://auth.x.ai/oauth2/token",
          issuer: "https://auth.x.ai",
          authFlow: "device-code",
          authorizationScope: "openid email profile",
          grantedScope: "openid profile",
        },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: {
        "openai:default": {
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: { billing: 2 },
        },
      },
    };
    const raw = structuredClone(expected);
    const store = coercePersistedAuthProfileStore({
      ...raw,
      version: "not-a-version",
      profiles: {
        ...raw.profiles,
        "openai:default": {
          ...raw.profiles["openai:default"],
          provider: " OpenAI ",
          key: "demo-openai-key",
          metadata: { account: "acct_123", bad: 123 },
          copyToAgents: "yes",
          email: ["wrong"],
        },
        "openai:legacy-malformed-ref": {
          ...raw.profiles["openai:legacy-malformed-ref"],
          keyRef: { source: "env", id: "" },
        },
        "minimax:default": {
          ...raw.profiles["minimax:default"],
          token: ["wrong"],
          expires: "tomorrow",
        },
        "openai:oauth": {
          ...raw.profiles["openai:oauth"],
          access: ["wrong"],
          expires: "later",
          oauthRef: { source: "openclaw-credentials", provider: "openai", id: "not-a-secret-id" },
        },
        "xai:oauth": { ...raw.profiles["xai:oauth"], deviceAuthorizationEndpoint: ["wrong"] },
        "broken:array": [],
      },
      order: { OpenAI: [" openai:default ", 5, ""], minimax: "wrong" },
      lastGood: { OpenAI: " openai:default ", minimax: 5 },
      usageStats: {
        "openai:default": {
          ...raw.usageStats["openai:default"],
          cooldownUntil: "later",
          failureCounts: { billing: 2, nope: 4 },
        },
        "minimax:default": "wrong",
      },
    });
    expect(store).toMatchObject(expected);
    expect(store?.profiles["broken:array"]).toBeUndefined();
    expect(store?.profiles["openai:default"]).not.toHaveProperty("copyToAgents");
    expect(store?.profiles["openai:oauth"]).not.toHaveProperty("oauthRef");
    expect(store?.profiles["xai:oauth"]).not.toHaveProperty("deviceAuthorizationEndpoint");
  });

  it("lets authoritative runtime external metadata remove stale base profiles", () => {
    const merged = mergeAuthProfileStores(
      makeStore(
        {
          "anthropic:claude-cli": oauth("stale-access", "stale-refresh", 1, "anthropic"),
        },
        {
          runtimeExternalProfileIds: ["anthropic:claude-cli"],
          runtimeExternalProfileIdsAuthoritative: true,
          order: { anthropic: ["anthropic:claude-cli"] },
          lastGood: { anthropic: "anthropic:claude-cli" },
        },
      ),
      makeStore(
        {},
        { runtimeExternalProfileIds: [], runtimeExternalProfileIdsAuthoritative: true },
      ),
    );

    expect(merged.runtimeExternalProfileIds).toEqual([]);
    expect(merged.runtimeExternalProfileIdsAuthoritative).toBe(true);
    expect(merged.profiles["anthropic:claude-cli"]).toBeUndefined();
    expect(merged.order?.anthropic).toBeUndefined();
    expect(merged.lastGood?.anthropic).toBeUndefined();
  });

  it("tracks persisted profile provenance with override precedence", () => {
    const sharedSource = { databasePath: "synthetic-shared.sqlite", provider: "openai" };
    const localSource = { databasePath: "synthetic-local.sqlite", provider: "openai" };
    const merged = mergeAuthProfileStores(
      makeStore(
        {
          "openai:base": apiKey("openai", "base-key"),
          "openai:overridden": apiKey("openai", "old-key"),
        },
        {
          runtimePersistedProfileIds: ["openai:base", "openai:overridden"],
          runtimeCredentialSources: {
            "openai:base": sharedSource,
            "openai:overridden": sharedSource,
          },
        },
      ),
      makeStore(
        {
          "openai:overridden": apiKey("openai", "scoped-key"),
          "openai:added": apiKey("openai", "added-key"),
        },
        {
          runtimePersistedProfileIds: ["openai:added"],
          runtimeLocalProfileIds: ["openai:added"],
          runtimeCredentialSources: { "openai:added": localSource },
        },
      ),
    );

    expect(merged.runtimePersistedProfileIds).toEqual(["openai:added", "openai:base"]);
    expect(merged.runtimeLocalProfileIds).toEqual(["openai:added"]);
    expect(merged.runtimeCredentialSources).toEqual({
      "openai:base": sharedSource,
      "openai:added": localSource,
    });
    expect(buildPersistedAuthProfileSecretsStore(merged)).toEqual({
      version: AUTH_STORE_VERSION,
      profiles: merged.profiles,
    });
  });

  it.each([
    {
      name: "unbound registered identity with a bound main-store account",
      localIdentity: { ...oidcIdentity(), accountId: undefined },
      mainIdentity: oidcIdentity(),
      replace: false,
    },
    {
      name: "unregistered legacy identities without comparable fields",
      localIdentity: { email: "legacy@example.test" },
      mainIdentity: { accountId: "main-account" },
      replace: true,
    },
  ])(
    "preserves the legacy replacement boundary for $name",
    ({ localIdentity, mainIdentity, replace }) => {
      const localProfileId = "openai:default";
      const mainProfileId = "openai:connected";
      const localCredential = { ...oauth("local-access", "local-refresh", 1), ...localIdentity };
      const merged = mergeAuthProfileStores(
        makeStore({
          [mainProfileId]: {
            ...oauth("main-access", "main-refresh", Date.now() + 600_000),
            ...mainIdentity,
          },
        }),
        makeStore(
          { [localProfileId]: localCredential },
          { order: { openai: [localProfileId] }, lastGood: { openai: localProfileId } },
        ),
      );
      expect(merged.profiles[localProfileId]).toEqual(replace ? undefined : localCredential);
      const selectedProfileId = replace ? mainProfileId : localProfileId;
      expect(merged.order?.openai).toEqual([selectedProfileId]);
      expect(merged.lastGood?.openai).toBe(selectedProfileId);
    },
  );

  it("prefers agent-local provider profiles before inherited main profiles", () => {
    const expires = Date.now() + 60_000;
    const merged = mergeAuthProfileStores(
      makeStore(
        {
          "minimax-portal:cli": oauth(
            "main-minimax-access",
            "main-minimax-refresh",
            expires,
            "minimax-portal",
          ),
        },
        { order: { "minimax-portal": ["minimax-portal:cli"] } },
      ),
      makeStore({
        "minimax-portal:default": oauth(
          "agent-minimax-access",
          "agent-minimax-refresh",
          expires,
          "minimax-portal",
        ),
      }),
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(Object.keys(merged.profiles)).toEqual(["minimax-portal:default", "minimax-portal:cli"]);
    expect(merged.order?.["minimax-portal"]).toEqual([
      "minimax-portal:default",
      "minimax-portal:cli",
    ]);
    expect(resolveAuthProfileOrder({ store: merged, provider: "minimax-portal" })).toEqual([
      "minimax-portal:default",
      "minimax-portal:cli",
    ]);
  });

  it("collapses normalized provider order keys without expanding explicit override order", () => {
    const merged = mergeAuthProfileStores(
      makeStore(
        {
          "openai:main": apiKey("OpenAI", "main-key"),
        },
        { order: { OpenAI: ["openai:main"] } },
      ),
      makeStore(
        {
          "openai:agent": apiKey("openai", "agent-key"),
          "openai:other-agent": apiKey("openai", "other-agent-key"),
        },
        { order: { openai: ["openai:agent"] } },
      ),
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(merged.order).toEqual({ openai: ["openai:agent"] });
  });

  it("keeps the winning external profile when stores are merged", () => {
    const profileId = "openai:default";
    const base: RuntimeAuthProfileStore = makeStore(
      {
        [profileId]: oauth("cli-access", "cli-refresh", 1),
      },
      { runtimeExternalProfileIds: [profileId] },
    );
    const inherited = mergeAuthProfileStores(base, makeStore({}), {
      preserveBaseRuntimeExternalProfiles: true,
    });
    expect(inherited.profiles).toEqual(base.profiles);

    const pluginOverride: RuntimeAuthProfileStore = makeStore(
      {
        [profileId]: oauth("plugin-access", "plugin-refresh", 2),
      },
      { runtimeExternalProfileIds: [profileId] },
    );
    const collided = mergeAuthProfileStores(base, pluginOverride);
    expect(collided.profiles[profileId]).toMatchObject({ access: "plugin-access" });
  });
});

it.each([
  [
    "chutes:default",
    {
      type: "oauth",
      provider: "chutes",
      access: "ACCESS_TOKEN",
      refresh: "REFRESH_TOKEN",
      expires: 1_900_000_000_000,
      clientId: "chutes-client-id-123",
      idToken: "ID_TOKEN_xyz",
      chatgptPlanType: "pro",
    },
  ],
  [
    "openai:default",
    {
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", id: "OPENAI_API_KEY" },
    },
  ],
  [
    "anthropic:default",
    {
      type: "token",
      provider: "anthropic",
      tokenRef: { source: "env", id: "ANTHROPIC_TOKEN" },
    },
  ],
] as const)("preserves legacy auth.json credential fields for %s", (profileId, credential) => {
  const legacy = coerceLegacyAuthStore({ [credential.provider]: structuredClone(credential) });
  expect(legacy).not.toBeNull();
  const store = makeStore({});
  applyLegacyAuthStore(store, legacy ?? {});
  expect(store.profiles[profileId]).toMatchObject(credential);
});
