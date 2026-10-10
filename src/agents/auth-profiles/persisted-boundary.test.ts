/**
 * Tests persisted auth profile boundary normalization.
 * Covers malformed credential coercion, state merging, legacy OAuth refs, and
 * main/agent store drift repair.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential, oidcIdentity } from "./credential-fixtures.test-support.js";
import { applyLegacyAuthStore, coerceLegacyAuthStore } from "./legacy-flat-credential.js";
import { resolveAuthProfileOrder } from "./order.js";
import {
  buildPersistedAuthProfileSecretsStore,
  coercePersistedAuthProfileStore,
  mergeAuthProfileStores,
} from "./persisted.js";
import { getRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
import { buildPersistedAuthProfileState, coerceAuthProfileState } from "./state.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

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
          "example:current": { type: "api_key", provider: "example", key: "synthetic-current-key" },
        },
      };
      const original = structuredClone(raw);
      expect(() => coercePersistedAuthProfileStore(raw)).toThrow("openclaw doctor --fix");
      expect(raw).toEqual(original);
    },
  );

  it.each([
    {
      name: "dead-account classification with permanent-auth reason",
      cooldownReason: "auth_permanent",
      cooldownClassification: "wham_account_dead",
      expectedClassification: "wham_account_dead",
    },
  ] as const)("normalizes $name", (testCase) => {
    const state = {
      usageStats: {
        "openai:default": {
          cooldownUntil: 1_900_000_000_000,
          cooldownReason: testCase.cooldownReason,
          cooldownClassification: testCase.cooldownClassification,
        },
      },
    };
    const normalizedStats = [
      coerceAuthProfileState(state).usageStats?.["openai:default"],
      buildPersistedAuthProfileState(state)?.usageStats?.["openai:default"],
    ];

    for (const stats of normalizedStats) {
      expect(stats?.cooldownReason).toBe(testCase.cooldownReason);
      expect(stats?.cooldownClassification).toBe(testCase.expectedClassification);
    }
  });

  it("normalizes malformed canonical credentials and state before runtime use", () => {
    const store = coercePersistedAuthProfileStore({
      version: "not-a-version",
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: " OpenAI ",
          key: "demo-openai-key",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123", bad: 123 },
          copyToAgents: "yes",
          email: ["wrong"],
          displayName: "Work",
        },
        "openai:legacy-api-key": {
          type: "api_key",
          provider: "openai",
          key: "legacy-openai-key",
        },
        "openai:legacy-malformed-ref": {
          type: "api_key",
          provider: "openai",
          key: "legacy-fallback-key",
          keyRef: { source: "env", id: "" },
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          token: ["wrong"],
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: "tomorrow",
        },
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          access: ["wrong"],
          refresh: "refresh-token",
          expires: "later",
          oauthRef: {
            source: "openclaw-credentials",
            provider: "openai",
            id: "not-a-secret-id",
          },
        },
        "xai:oauth": {
          type: "oauth",
          provider: "xai",
          access: "synthetic-xai-access",
          refresh: "synthetic-xai-refresh",
          expires: 1_900_000_000_000,
          tokenEndpoint: "https://auth.x.ai/oauth2/token",
          deviceAuthorizationEndpoint: ["wrong"],
          issuer: "https://auth.x.ai",
          authFlow: "device-code",
          authorizationScope: "openid email profile",
          grantedScope: "openid profile",
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
        "openai:legacy-api-key": {
          type: "api_key",
          provider: "openai",
          key: "legacy-openai-key",
        },
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
    expect(store?.profiles["openai:default"]).not.toHaveProperty("copyToAgents");
    expect(store?.profiles["openai:oauth"]).not.toHaveProperty("oauthRef");
    expect(store?.profiles["xai:oauth"]).not.toHaveProperty("deviceAuthorizationEndpoint");
  });

  it("lets authoritative runtime external metadata remove stale base profiles", () => {
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: ["anthropic:claude-cli"],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          "anthropic:claude-cli": {
            type: "oauth",
            provider: "anthropic",
            access: "stale-access",
            refresh: "stale-refresh",
            expires: 1,
          },
        },
        order: {
          anthropic: ["anthropic:claude-cli"],
        },
        lastGood: {
          anthropic: "anthropic:claude-cli",
        },
      },
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {},
      },
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
      {
        version: AUTH_STORE_VERSION,
        runtimePersistedProfileIds: ["openai:base", "openai:overridden"],
        runtimeCredentialSources: {
          "openai:base": sharedSource,
          "openai:overridden": sharedSource,
        },
        profiles: {
          "openai:base": createApiKeyCredential("openai", "base-key"),
          "openai:overridden": createApiKeyCredential("openai", "old-key"),
        },
      },
      {
        version: AUTH_STORE_VERSION,
        runtimePersistedProfileIds: ["openai:added"],
        runtimeLocalProfileIds: ["openai:added"],
        runtimeCredentialSources: { "openai:added": localSource },
        profiles: {
          "openai:overridden": createApiKeyCredential("openai", "scoped-key"),
          "openai:added": createApiKeyCredential("openai", "added-key"),
        },
      },
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
      const localCredential = {
        type: "oauth" as const,
        provider: "openai",
        access: "local-access",
        refresh: "local-refresh",
        expires: 1,
        ...localIdentity,
      };
      const merged = mergeAuthProfileStores(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [mainProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 600_000,
              ...mainIdentity,
            },
          },
        },
        {
          version: AUTH_STORE_VERSION,
          profiles: { [localProfileId]: localCredential },
          order: { openai: [localProfileId] },
          lastGood: { openai: localProfileId },
        },
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
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "minimax-portal:cli": {
            type: "oauth",
            provider: "minimax-portal",
            access: "main-minimax-access",
            refresh: "main-minimax-refresh",
            expires,
          },
        },
        order: {
          "minimax-portal": ["minimax-portal:cli"],
        },
      },
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "agent-minimax-access",
            refresh: "agent-minimax-refresh",
            expires,
          },
        },
      },
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
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:main": createApiKeyCredential("OpenAI", "main-key"),
        },
        order: {
          OpenAI: ["openai:main"],
        },
      },
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:agent": createApiKeyCredential("openai", "agent-key"),
          "openai:other-agent": createApiKeyCredential("openai", "other-agent-key"),
        },
        order: {
          openai: ["openai:agent"],
        },
      },
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(merged.order).toEqual({
      openai: ["openai:agent"],
    });
  });

  it("carries built-in CLI provenance only with the winning external profile", () => {
    const profileId = "openai:default";
    const base: RuntimeAuthProfileStore = {
      version: AUTH_STORE_VERSION,
      runtimeExternalProfileIds: [profileId],
      runtimeExternalCliProfileIds: [profileId],
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          access: "cli-access",
          refresh: "cli-refresh",
          expires: 1,
        },
      },
    };
    const inherited = mergeAuthProfileStores(
      base,
      { version: AUTH_STORE_VERSION, profiles: {} },
      { preserveBaseRuntimeExternalProfiles: true },
    );
    expect(getRuntimeExternalCliProfileIds(inherited)).toEqual([profileId]);

    const pluginOverride: RuntimeAuthProfileStore = {
      version: AUTH_STORE_VERSION,
      runtimeExternalProfileIds: [profileId],
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          access: "plugin-access",
          refresh: "plugin-refresh",
          expires: 2,
        },
      },
    };
    const collided = mergeAuthProfileStores(base, pluginOverride);
    expect(collided.profiles[profileId]).toMatchObject({ access: "plugin-access" });
    expect(getRuntimeExternalCliProfileIds(collided)).toEqual([]);
  });
});

describe("applyLegacyAuthStore", () => {
  const agentDirs: string[] = [];

  afterEach(() => {
    for (const dir of agentDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeLegacyAuthJson(value: unknown): string {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-legacy-auth-"));
    agentDirs.push(agentDir);
    fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(value), "utf8");
    return agentDir;
  }

  it("preserves OAuth refresh material when migrating legacy auth.json", () => {
    const agentDir = writeLegacyAuthJson({
      chutes: {
        type: "oauth",
        provider: "chutes",
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: 1_900_000_000_000,
        clientId: "chutes-client-id-123",
        idToken: "ID_TOKEN_xyz",
        chatgptPlanType: "pro",
      },
    });
    const legacy = coerceLegacyAuthStore(
      JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")),
    );
    expect(legacy).not.toBeNull();

    const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
    applyLegacyAuthStore(store, legacy ?? {});

    expect(store.profiles["chutes:default"]).toMatchObject({
      type: "oauth",
      provider: "chutes",
      access: "ACCESS_TOKEN",
      refresh: "REFRESH_TOKEN",
      clientId: "chutes-client-id-123",
      idToken: "ID_TOKEN_xyz",
      chatgptPlanType: "pro",
    });
  });

  it("preserves secret-ref credentials when migrating legacy auth.json", () => {
    const agentDir = writeLegacyAuthJson({
      openai: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", id: "OPENAI_API_KEY" },
      },
      anthropic: {
        type: "token",
        provider: "anthropic",
        tokenRef: { source: "env", id: "ANTHROPIC_TOKEN" },
      },
    });
    const legacy = coerceLegacyAuthStore(
      JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")),
    );
    expect(legacy).not.toBeNull();

    const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
    applyLegacyAuthStore(store, legacy ?? {});

    expect(store.profiles["openai:default"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", id: "OPENAI_API_KEY" },
    });
    expect(store.profiles["anthropic:default"]).toMatchObject({
      type: "token",
      provider: "anthropic",
      tokenRef: { source: "env", id: "ANTHROPIC_TOKEN" },
    });
  });
});
