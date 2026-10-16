import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "../models-config.providers.secrets.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import type { AuthProfileStore } from "./types.js";

const authOrder = (provider: string, ...ids: string[]): OpenClawConfig => ({
  auth: { order: { [provider]: ids } },
});

function expectSelection(
  store: AuthProfileStore,
  config: OpenClawConfig,
  provider: string,
  apiKey: string,
  profileId: string,
) {
  for (const resolve of [createProviderAuthResolver, createProviderApiKeyResolver]) {
    expect(resolve({}, store, config)(provider)).toMatchObject({ apiKey, profileId });
  }
}

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({ "proof-alias": "openai" }),
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === "proof-alias" ? "openai" : normalized;
  },
}));

vi.mock("../model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => [],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: { "proof-alias": "openai" },
    envCandidateMap: { openai: ["OPENAI_API_KEY"] },
    authEvidenceMap: {},
  }),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

describe("provider catalog auth order", () => {
  it("uses configured, stored, cooldown, and alias ordering", () => {
    const profileA = "openai:profile-a";
    const profileB = "openai:profile-b";
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      [profileA]: createApiKeyCredential("openai", "key-a"),
      [profileB]: createApiKeyCredential("openai", "key-b"),
    });
    const config = authOrder("openai", profileB, profileA);

    expect(createProviderAuthResolver({}, store, config)("openai")).toMatchObject({
      apiKey: "key-b",
      profileId: profileB,
    });
    expect(createProviderApiKeyResolver({}, store, config)("openai")).toMatchObject({
      apiKey: "key-b",
      mode: "api_key",
      profileId: profileB,
    });

    store.order = { openai: [profileA, profileB] };
    expect(createProviderAuthResolver({}, store, config)("openai")).toMatchObject({
      apiKey: "key-a",
      profileId: profileA,
    });

    delete store.order;
    store.usageStats = {
      [profileA]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "gpt-5.5",
      },
    };
    const cooldownConfig = authOrder("openai", profileA, profileB);
    expectSelection(store, cooldownConfig, "openai", "key-a", profileA);

    store.usageStats = {
      [profileA]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
      },
    };
    expectSelection(store, cooldownConfig, "openai", "key-b", profileB);
    expectSelection(
      store,
      authOrder("proof-alias", profileB, profileA),
      "proof-alias",
      "key-b",
      profileB,
    );
  });

  it("keeps the static credential kind separate from the preferred OAuth profile", () => {
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      "minimax-portal:token": {
        type: "token",
        provider: "minimax-portal",
        token: "catalog-token",
      },
      "minimax-portal:oauth": createOAuthRefreshCredential({
        provider: "minimax-portal",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 60 * 60_000,
      }),
    });
    expect(createProviderApiKeyResolver({}, store)("minimax-portal")).toMatchObject({
      apiKey: "catalog-token",
      discoveryApiKey: "catalog-token",
      mode: "token",
      profileId: "minimax-portal:token",
    });
    expect(createProviderAuthResolver({}, store)("minimax-portal")).toMatchObject({
      mode: "oauth",
      profileId: "minimax-portal:oauth",
    });
  });

  it.each(["oauth", "token"] as const)(
    "preserves configured %s mode for direct catalog credentials",
    (mode) => {
      const store: AuthProfileStore = { version: 1, profiles: {} };
      const provider = {
        auth: mode,
        apiKey: "literal-catalog-token",
        baseUrl: "https://api.openai.com/v1",
        models: [],
      };
      const config: OpenClawConfig = {
        models: { providers: { openai: provider } },
      };
      const envConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              ...provider,
              apiKey: { source: "env", provider: "default", id: "CATALOG_TOKEN" },
            },
          },
        },
      };
      for (const resolve of [createProviderAuthResolver, createProviderApiKeyResolver]) {
        expect(resolve({}, store, config)("openai")).toMatchObject({
          mode,
          discoveryApiKey: "literal-catalog-token",
        });
        expect(
          resolve({ CATALOG_TOKEN: "env-catalog-token" }, store, envConfig)("openai"),
        ).toMatchObject({ mode, discoveryApiKey: "env-catalog-token" });
        expect(
          resolve({ OPENAI_API_KEY: "direct-env-token" }, store, config)("openai"),
        ).toMatchObject({ mode, discoveryApiKey: "direct-env-token" });
      }
    },
  );

  it("keeps unresolved OAuth refs selected for locked catalog resolution", () => {
    const profileId = "openai:oauth-ref";
    const auth = createProviderAuthResolver(
      {},
      createAuthProfileStoreFixture({
        [profileId]: createOAuthRefreshCredential({
          access: "",
          refresh: "",
          expires: 0,
          oauthRef: {
            source: "openclaw-credentials",
            provider: "openai-codex",
            id: "00000000000000000000000000000000",
          },
        }),
      }),
      authOrder("openai", profileId),
    )("openai");

    expect(auth).toMatchObject({
      apiKey: undefined,
      mode: "oauth",
      profileId,
      source: "profile",
    });
  });

  it("supports owner-local exclusion of a failed canonical profile", () => {
    const profileA = "openai:oauth-a";
    const profileB = "openai:api-key-b";
    const resolveAuth = createProviderAuthResolver(
      {},
      createAuthProfileStoreFixture({
        [profileA]: createOAuthRefreshCredential({
          access: "oauth-a",
          refresh: "refresh-a",
          expires: Date.now() + 60_000,
        }),
        [profileB]: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "file", provider: "vault", id: "/openai/profile-b" },
        },
      }),
      authOrder("openai", profileA, profileB),
    );

    expect(resolveAuth("openai")).toMatchObject({
      mode: "oauth",
      profileId: profileA,
    });
    expect(resolveAuth("openai", { excludeProfileIds: [profileA] })).toMatchObject({
      mode: "api_key",
      profileId: profileB,
    });
  });
});
