import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
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

const resolvers = [createProviderAuthResolver, createProviderApiKeyResolver];
const first = "openai:profile-a";
const second = "openai:profile-b";
const authOrder = (provider: string, ids: string[]): OpenClawConfig => ({
  auth: { order: { [provider]: ids } },
});
const catalogConfig = (
  auth: "oauth" | "token",
  apiKey: ModelProviderConfig["apiKey"],
): OpenClawConfig => ({
  models: {
    providers: { openai: { auth, apiKey, baseUrl: "https://api.openai.com/v1", models: [] } },
  },
});

describe("provider catalog auth order", () => {
  it.each([
    { name: "configured", order: [second, first], expected: second },
    { name: "stored", order: [second, first], stored: [first, second], expected: first },
    {
      name: "model cooldown",
      order: [first, second],
      cooldown: true,
      model: "gpt-5.5",
      expected: first,
    },
    { name: "provider cooldown", order: [first, second], cooldown: true, expected: second },
    { name: "alias", provider: "proof-alias", order: [second, first], expected: second },
  ])("uses $name ordering", ({ order, stored, cooldown, model, provider = "openai", expected }) => {
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      [first]: createApiKeyCredential("openai", "key-a"),
      [second]: createApiKeyCredential("openai", "key-b"),
    });
    if (stored) {
      store.order = { openai: stored };
    }
    if (cooldown) {
      store.usageStats = {
        [first]: {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          ...(model ? { cooldownModel: model } : {}),
        },
      };
    }
    for (const resolve of resolvers) {
      expect(resolve({}, store, authOrder(provider, order))(provider)).toMatchObject({
        apiKey: expected === first ? "key-a" : "key-b",
        profileId: expected,
        mode: "api_key",
      });
    }
  });

  it("keeps the static credential kind separate from the preferred OAuth profile", () => {
    const store = createAuthProfileStoreFixture({
      "minimax-portal:token": {
        type: "token" as const,
        provider: "minimax-portal",
        token: "catalog-token",
      },
      "minimax-portal:oauth": createOAuthRefreshCredential({ provider: "minimax-portal" }),
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
      const config = catalogConfig(mode, "literal-catalog-token");
      const envConfig = catalogConfig(mode, {
        source: "env",
        provider: "default",
        id: "CATALOG_TOKEN",
      });
      for (const resolve of resolvers) {
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
    const store = createAuthProfileStoreFixture({
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
    });
    expect(
      createProviderAuthResolver({}, store, authOrder("openai", [profileId]))("openai"),
    ).toMatchObject({ apiKey: undefined, mode: "oauth", profileId, source: "profile" });
  });

  it("supports owner-local exclusion of a failed canonical profile", () => {
    const profileA = "openai:oauth-a";
    const profileB = "openai:api-key-b";
    const resolveAuth = createProviderAuthResolver(
      {},
      createAuthProfileStoreFixture({
        [profileA]: createOAuthRefreshCredential(),
        [profileB]: {
          type: "api_key" as const,
          provider: "openai",
          keyRef: { source: "file" as const, provider: "vault", id: "/openai/profile-b" },
        },
      }),
      authOrder("openai", [profileA, profileB]),
    );
    expect(resolveAuth("openai")).toMatchObject({ mode: "oauth", profileId: profileA });
    expect(resolveAuth("openai", { excludeProfileIds: [profileA] })).toMatchObject({
      mode: "api_key",
      profileId: profileB,
    });
  });
});
