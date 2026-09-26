import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import {
  configRef,
  configWithKey,
  createProviderApiKeyResolver,
  createProviderAuthResolver,
  createProviderAuthDiscoveryFixture,
  setupProviderAuthProvenanceTests,
} from "./models-config.providers.auth-test-support.js";

setupProviderAuthProvenanceTests();

describe("configured catalog profile bindings", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const withDiscoveryFixture = createProviderAuthDiscoveryFixture(tempDirs);
  const discoveryCases = [
    ["api_key", "resolveProviderAuth"],
    ["token", "resolveProviderAuth"],
    ["api_key", "resolveProviderApiKey"],
    ["token", "resolveProviderApiKey"],
  ] as const;
  it.each(discoveryCases)(
    "redeems a configured %s profile binding through %s before catalog HTTP",
    async (type, callback) => {
      await withDiscoveryFixture(type, callback, async (fixture) => {
        fixture.store.profiles["openai:other"] = createApiKeyCredential("openai", "other-account");
        fixture.emitOutcome();
        await fixture.discover({
          ...configWithKey(fixture.profileId),
          auth: { order: { openai: ["openai:other"] } },
        });
        expect(fixture.authorization).toEqual([`Bearer ${fixture.runtimeKey}`]);
        expect(fixture.authResults).toEqual([
          expect.objectContaining({
            apiKey: NON_ENV_SECRETREF_MARKER,
            discoveryApiKey: fixture.runtimeKey,
            profileId: fixture.profileId,
            mode: type,
          }),
        ]);
        expect(fixture.outcomes).toEqual([
          { provider: "openai", profileId: fixture.profileId, status: "ready" },
        ]);
      });
    },
  );
  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "redeems the canonical configured binding through provider aliases with %s",
    async (callback) => {
      await withDiscoveryFixture(
        "api_key",
        callback,
        async (fixture) => {
          fixture.store.profiles["openai:other"] = createApiKeyCredential(
            "openai",
            "other-account",
          );
          fixture.emitOutcome();
          await fixture.discover({
            ...configWithKey(fixture.profileId),
            auth: { order: { openai: ["openai:other"] } },
          });
          expect(fixture.authorization).toEqual([`Bearer ${fixture.runtimeKey}`]);
          expect(fixture.outcomes).toEqual([
            { provider: "openai", profileId: fixture.profileId, status: "ready" },
          ]);
        },
        "proof-alias",
      );
    },
  );
  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "stops an ineligible configured profile binding through %s before catalog HTTP",
    async (callback) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        fixture.store.profiles[fixture.profileId] = { type: "api_key", provider: "openai" };
        fixture.store.profiles["openai:other"] = createApiKeyCredential("openai", "other-account");
        const providers = await fixture.discover(configWithKey(fixture.profileId));
        expect(fixture.authorization).toEqual([]);
        expect(fixture.errors).toHaveLength(1);
        expect(fixture.errors[0]).toBeInstanceOf(Error);
        expect(providers?.openai).toBeUndefined();
        expect(providers?.healthy).toBeDefined();
      });
    },
  );
  it("keeps materialized config SecretRef bytes opaque when they match a stored profile", async () => {
    await withDiscoveryFixture("api_key", "resolveProviderApiKey", async (fixture) => {
      await fixture.plan(configWithKey(configRef), configWithKey(fixture.profileId));
      expect(fixture.authorization).toEqual([`Bearer ${fixture.profileId}`]);
      expect(fixture.authResults).toEqual([
        { apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: fixture.profileId, mode: "api_key" },
      ]);
    });
  });
  it.each([
    {
      name: "expired token",
      credential: { type: "token", provider: "openai", token: "expired-token", expires: 1 },
    },
    {
      name: "inactive setup replacement",
      credential: {
        type: "api_key",
        provider: "openai",
        key: "inactive-key",
        setup: { replacement: true, modelRef: "openai/test-model", configJson: "{}" },
      },
    },
    {
      name: "incompatible provider",
      credential: { type: "api_key", provider: "unrelated", key: "unrelated-key" },
    },
  ] satisfies Array<{ name: string; credential: AuthProfileCredential }>)(
    "does not reinterpret a configured $name binding as a literal or another profile",
    ({ credential }) => {
      const auth = createProviderApiKeyResolver(
        {},
        createAuthProfileStoreFixture({
          "openai:bound": credential,
          "openai:other": createApiKeyCredential("openai", "other-account"),
        }),
        configWithKey("openai:bound"),
      );
      expect(() => auth("openai")).toThrow(/Configured apiKey profile/);
    },
  );
  it("honors explicit callback exclusions for a bound catalog profile", () => {
    const auth = createProviderAuthResolver(
      {},
      createAuthProfileStoreFixture({
        "openai:bound": createApiKeyCredential("openai", "bound-account"),
        "openai:other": createApiKeyCredential("openai", "other-account"),
      }),
      configWithKey("openai:bound"),
    );
    expect(() => auth("openai", { excludeProfileIds: ["openai:bound"] })).toThrow(
      /Configured apiKey profile/,
    );
  });
  it("retains literal and env-first contracts without inventing missing profile bindings", () => {
    const store = createAuthProfileStoreFixture({
      "openai:bound": createApiKeyCredential("openai", "bound-account"),
    });
    expect(
      createProviderApiKeyResolver({}, store, configWithKey("absent:manual"))("openai"),
    ).toEqual({ apiKey: "absent:manual", discoveryApiKey: "absent:manual", mode: "api_key" });
    expect(
      createProviderApiKeyResolver(
        { OPENAI_API_KEY: "ambient-key" },
        store,
        configWithKey("openai:bound"),
      )("openai"),
    ).toEqual({ apiKey: "OPENAI_API_KEY", discoveryApiKey: "ambient-key", mode: "api_key" });
  });
  it("uses the canonical same-endpoint contract for a split-provider profile binding", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: { baseUrl: "https://catalog.example.test/v1", models: [] },
          split: {
            baseUrl: "https://catalog.example.test/v1",
            apiKey: "openai:bound",
            models: [],
          },
        },
      },
    };
    const auth = createProviderApiKeyResolver(
      {},
      createAuthProfileStoreFixture({
        "openai:bound": createApiKeyCredential("openai", "bound-account"),
      }),
      config,
    );
    expect(auth("split")).toEqual({
      apiKey: "bound-account",
      discoveryApiKey: "bound-account",
      profileId: "openai:bound",
      mode: "api_key",
    });
  });
});
