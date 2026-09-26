// Verifies persisted provider auth markers preserve credential provenance.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { captureEnv } from "../test-utils/env.js";
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
  CUSTOM_LOCAL_AUTH_MARKER,
  mockedResolveProviderSyntheticAuthWithPlugin,
  resolveApiKeyFromCredential,
  setupProviderAuthProvenanceTests,
} from "./models-config.providers.auth-test-support.js";
import {
  normalizeProviderSpecificConfig,
  resolveProviderConfigApiKeyResolver,
} from "./models-config.providers.policy.js";

setupProviderAuthProvenanceTests();

describe("models-config provider auth provenance", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const withDiscoveryFixture = createProviderAuthDiscoveryFixture(tempDirs);

  const discoveryCases = [
    ["api_key", "resolveProviderAuth"],
    ["token", "resolveProviderAuth"],
    ["api_key", "resolveProviderApiKey"],
    ["token", "resolveProviderApiKey"],
  ] as const;
  const discoveryRefCases = discoveryCases.flatMap(([type, callback]) =>
    (["store", "env"] as const).map((refSource) => ({ type, callback, refSource })),
  );
  it.each(discoveryRefCases)(
    "authenticates published $refSource-backed $type discovery through $callback",
    async ({ type, callback, refSource }) => {
      await withDiscoveryFixture(
        type,
        callback,
        async (fixture) => {
          const marker = refSource === "env" ? "DISCOVERY_KEY" : NON_ENV_SECRETREF_MARKER;
          expect(await fixture.canonical()).toBe(fixture.runtimeKey);
          const providers = await fixture.discover();
          expect(providers?.openai?.apiKey).toBe(marker);
          expect(JSON.stringify(providers)).not.toContain(fixture.runtimeKey);
          expect(fixture.authorization).toEqual([`Bearer ${fixture.runtimeKey}`]);
          const plan = await fixture.plan();
          expect(plan.action).toBe("write");
          expect(JSON.stringify(plan)).toContain(marker);
          expect(JSON.stringify(plan)).not.toMatch(/runtime-discovery-key|stale-inline/);
        },
        "openai",
        refSource,
      );
    },
  );

  const unavailableStates = [
    "unpublished",
    "agent-mismatch",
    "ref-mismatch",
    "provider-mismatch",
    "missing-profile",
    "missing-value",
    "cleared",
    "cold",
  ] as const;
  it.each(
    discoveryRefCases.flatMap(({ type, callback, refSource }) =>
      unavailableStates
        .filter((state) => {
          if (refSource === "env") {
            return (
              (state === "cold" || state === "unpublished") &&
              ((type === "api_key" && callback === "resolveProviderAuth") ||
                (type === "token" && callback === "resolveProviderApiKey"))
            );
          }
          if (callback === "resolveProviderApiKey") {
            return state === "unpublished";
          }
          return (
            type === "api_key" ||
            state === "ref-mismatch" ||
            state === "missing-value" ||
            state === "cold" ||
            state === "unpublished"
          );
        })
        .map((state) => ({ type, callback, refSource, state })),
    ),
  )(
    "isolates $refSource-backed $type $state through $callback without fallback or anonymous HTTP",
    async ({ type, callback, refSource, state }) => {
      await withDiscoveryFixture(
        type,
        callback,
        async (fixture) => {
          const { SecretSurfaceUnavailableError } =
            await import("../secrets/runtime-degraded-state.js");
          fixture.store.profiles["openai:other"] = createApiKeyCredential(
            "openai",
            "wrong-account-key",
          );
          const profile = expectDefined(
            fixture.published.profiles[fixture.profileId],
            "published profile",
          );
          if (state === "cleared") {
            await fixture.discover();
            expect(fixture.authorization).toEqual([`Bearer ${fixture.runtimeKey}`]);
            fixture.authorization.length = 0;
          }
          if (state === "unpublished" || state === "cleared") {
            fixture.clear();
          }
          if (state === "agent-mismatch") {
            fixture.clear();
            fixture.publish(path.join(fixture.agentDir, "other"));
          }
          if (state === "missing-profile") {
            delete fixture.published.profiles[fixture.profileId];
          }
          if (state === "provider-mismatch") {
            profile.provider = "other-provider";
          }
          if (state === "ref-mismatch") {
            const changedRef = { source: "store", provider: "default", id: "OTHER_KEY" } as const;
            if (profile.type === "api_key") {
              profile.keyRef = changedRef;
            } else if (profile.type === "token") {
              profile.tokenRef = changedRef;
            }
          }
          if (state === "missing-value") {
            if (profile.type === "api_key") {
              delete profile.key;
            } else if (profile.type === "token") {
              delete profile.token;
            }
          }
          if (!["unpublished", "cleared", "agent-mismatch"].includes(state)) {
            fixture.publish();
          }
          if (state === "cold") {
            fixture.cold();
          }
          // Profile-first resolution must not escape to otherwise valid ambient auth.
          if (callback === "resolveProviderAuth") {
            fixture.env.OPENAI_API_KEY = "wrong-env-key";
          }
          const providers = await fixture.discover();
          expect(fixture.authorization).toEqual([]);
          expect(fixture.errors).toHaveLength(1);
          expect(fixture.errors[0]).toBeInstanceOf(SecretSurfaceUnavailableError);
          expect(fixture.outcomes).toEqual([
            { provider: "openai", profileId: fixture.profileId, status: "unavailable" },
          ]);
          expect(providers?.openai).toBeUndefined();
          expect(providers?.healthy).toBeDefined();
          expect(JSON.stringify([providers, fixture.outcomes])).not.toMatch(
            /stale-inline|wrong-account-key|wrong-env-key|runtime-discovery-key/,
          );
        },
        "openai",
        refSource,
      );
    },
  );

  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "skips expired profiles through %s and uses the next canonical candidate",
    async (callback) => {
      await withDiscoveryFixture("token", callback, async (fixture) => {
        const selected = expectDefined(
          fixture.store.profiles[fixture.profileId],
          "selected profile",
        );
        if (selected.type !== "token") {
          throw new Error("expected token profile");
        }
        selected.expires = 1;
        fixture.store.profiles["openai:fallback"] = createApiKeyCredential(
          "openai",
          "eligible-fallback-key",
        );

        await fixture.discover();

        expect(fixture.authorization).toEqual(["Bearer eligible-fallback-key"]);
        expect(fixture.errors).toEqual([]);
      });
    },
  );

  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "keeps plain, env and OAuth controls through %s",
    async (callback) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        fixture.clear();
        for (const profile of [
          { type: "api_key", provider: "openai", key: "plain-key" },
          {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "PROFILE_KEY" },
          },
          {
            type: "oauth",
            provider: "openai",
            access: "oauth-key",
            refresh: "unused-refresh",
            expires: Date.now() + 600_000,
          },
        ] satisfies AuthProfileCredential[]) {
          fixture.store.profiles[fixture.profileId] = profile;
          fixture.env.PROFILE_KEY = "env-ref-key";
          if (profile.type === "oauth" && callback === "resolveProviderApiKey") {
            continue;
          }
          await fixture.discover();
        }
        expect(fixture.authorization).toEqual(
          callback === "resolveProviderAuth"
            ? ["Bearer plain-key", "Bearer env-ref-key", "Bearer oauth-key"]
            : ["Bearer plain-key", "Bearer env-ref-key"],
        );
        expect(fixture.errors).toEqual([]);
      });
    },
  );

  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "preserves profile/env precedence and ignores unselected failures through %s",
    async (callback) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        fixture.env.OPENAI_API_KEY = "ambient-key";
        fixture.store.profiles["openai:unselected"] = {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "store", provider: "default", id: "UNPUBLISHED" },
        };
        fixture.store.profiles["unrelated:oauth"] = {
          type: "oauth",
          provider: "unrelated",
          access: "expired",
          refresh: "must-not-refresh",
          expires: 1,
        };
        const resolveProfile = vi.spyOn(
          await import("./auth-profiles/oauth.js"),
          "resolveApiKeyForProfile",
        );
        try {
          await fixture.discover();
          await fixture.plan(configWithKey(configRef));
          const expectedKey =
            callback === "resolveProviderAuth" ? fixture.runtimeKey : "ambient-key";
          expect(fixture.authorization).toEqual([`Bearer ${expectedKey}`, `Bearer ${expectedKey}`]);
          expect(resolveProfile.mock.calls.map(([params]) => params.profileId)).not.toContain(
            "unrelated:oauth",
          );
          expect(fixture.errors).toEqual([]);
          expect(fixture.outcomes).toEqual([]);
        } finally {
          resolveProfile.mockRestore();
        }
      });
    },
  );

  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "preserves the selected profile through provider aliases with %s",
    async (callback) => {
      await withDiscoveryFixture(
        "api_key",
        callback,
        async (fixture) => {
          fixture.emitOutcome();
          await fixture.discover();
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
    "applies stored catalog order through %s",
    async (callback) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        const backupProfileId = "openai:stored-first";
        fixture.store.profiles[backupProfileId] = createApiKeyCredential(
          "openai",
          "stored-order-key",
        );
        fixture.store.order = {
          openai: [backupProfileId, fixture.profileId],
        };
        fixture.emitOutcome();

        await fixture.discover({
          auth: {
            order: {
              openai: [fixture.profileId, backupProfileId],
            },
          },
        });

        expect(fixture.authorization).toEqual(["Bearer stored-order-key"]);
        expect(fixture.outcomes).toEqual([
          { provider: "openai", profileId: backupProfileId, status: "ready" },
        ]);
      });
    },
  );

  it.each([
    {
      name: "keeps a profile with a one-model cooldown",
      usage: {
        cooldownReason: "rate_limit" as const,
        cooldownModel: "gpt-5.5",
      },
      expectedProfile: "selected",
      expectedKey: "runtime",
    },
    {
      name: "demotes a profile-wide cooldown",
      usage: {
        cooldownReason: "rate_limit" as const,
      },
      expectedProfile: "backup",
      expectedKey: "backup",
    },
  ])("$name during prepared catalog discovery", async ({ usage, expectedProfile, expectedKey }) => {
    await withDiscoveryFixture("api_key", "resolveProviderAuth", async (fixture) => {
      const backupProfileId = "openai:cooldown-backup";
      fixture.store.profiles[backupProfileId] = {
        type: "api_key",
        provider: "openai",
        key: "cooldown-backup-key",
      };
      fixture.store.usageStats = {
        [fixture.profileId]: { ...usage, cooldownUntil: Date.now() + 60_000 },
      };
      fixture.emitOutcome();

      await fixture.discover({
        auth: {
          order: {
            openai: [fixture.profileId, backupProfileId],
          },
        },
      });

      const expectedProfileId =
        expectedProfile === "selected" ? fixture.profileId : backupProfileId;
      const expectedAuthorization =
        expectedKey === "runtime" ? `Bearer ${fixture.runtimeKey}` : "Bearer cooldown-backup-key";
      expect(fixture.authorization).toEqual([expectedAuthorization]);
      expect(fixture.outcomes).toEqual([
        { provider: "openai", profileId: expectedProfileId, status: "ready" },
      ]);
    });
  });

  it.each(
    (["resolveProviderAuth", "resolveProviderApiKey"] as const).flatMap((callback) =>
      [
        "prepared-config-key",
        "ollama-local",
        "OLLAMA_API_KEY",
        "secretref-managed",
        "${OPAQUE_KEY}",
      ].map((value) => ({ callback, value })),
    ),
  )(
    "keeps prepared config Ref bytes $value opaque through $callback",
    async ({ callback, value }) => {
      await withDiscoveryFixture(
        "api_key",
        callback,
        async (fixture) => {
          fixture.store.profiles = {};
          const plan = await fixture.plan(configWithKey(configRef), configWithKey(value));
          expect(fixture.authResults).toEqual([
            expect.objectContaining({ apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: value }),
          ]);
          expect(fixture.authorization).toEqual([`Bearer ${value}`]);
          expect(plan.action).toBe("write");
          expect(JSON.stringify(plan)).toContain(NON_ENV_SECRETREF_MARKER);
          if (value !== NON_ENV_SECRETREF_MARKER) {
            expect(JSON.stringify(plan)).not.toContain(value);
          }
          expect(JSON.stringify(plan)).not.toContain("discoveryApiKey");
        },
        "proof-alias",
      );
    },
  );

  it.each(
    (["resolveProviderAuth", "resolveProviderApiKey"] as const).flatMap((callback) =>
      ["missing", "empty", "unmaterialized"].map((state) => ({ callback, state })),
    ),
  )(
    "isolates selected $state config refs through $callback before HTTP",
    async ({ callback, state }) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        const { SecretSurfaceUnavailableError } =
          await import("../secrets/runtime-degraded-state.js");
        fixture.store.profiles =
          callback === "resolveProviderApiKey"
            ? { "openai:lower": { type: "api_key", provider: "openai", key: "wrong-account-key" } }
            : {};
        fixture.env.CONFIG_KEY = "wrong-env-key";
        const value = state === "missing" ? undefined : state === "empty" ? "" : configRef;
        const plan = await fixture.plan(configWithKey(configRef), configWithKey(value));
        expect(fixture.authorization).toEqual([]);
        expect(fixture.errors).toHaveLength(1);
        expect(fixture.errors[0]).toBeInstanceOf(SecretSurfaceUnavailableError);
        expect(fixture.outcomes).toEqual([{ provider: "openai", status: "unavailable" }]);
        expect(JSON.stringify(plan)).toContain("healthy");
        expect(JSON.stringify(plan)).not.toMatch(/wrong-account-key|wrong-env-key/);
      });
    },
  );

  it("persists env keyRef and tokenRef auth profiles as env var markers", () => {
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY", "TOGETHER_API_KEY"]);
    delete process.env.VOLCANO_ENGINE_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    try {
      const volcengineApiKey = resolveApiKeyFromCredential({
        type: "api_key",
        provider: "volcengine",
        keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
      })?.apiKey;
      const togetherApiKey = resolveApiKeyFromCredential({
        type: "token",
        provider: "together",
        tokenRef: { source: "env", provider: "default", id: "TOGETHER_API_KEY" },
      })?.apiKey;
      expect(volcengineApiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(togetherApiKey).toBe("TOGETHER_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for ref-managed profiles even when runtime plaintext is present", () => {
    // Ref-managed secrets may be resolved in memory, but models.json should
    // persist only a non-env marker so plaintext is not written back.
    const byteplusApiKey = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "byteplus",
      key: "sk-runtime-resolved-byteplus",
      keyRef: { source: "file", provider: "vault", id: "/byteplus/apiKey" },
    })?.apiKey;
    const togetherApiKey = resolveApiKeyFromCredential({
      type: "token",
      provider: "together",
      token: "tok-runtime-resolved-together",
      tokenRef: { source: "exec", provider: "vault", id: "providers/together/token" },
    })?.apiKey;
    expect(byteplusApiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(togetherApiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it.each(["chatgpt-token-sharing", "chatgpt-identity"])(
    "exposes %s to provider catalog policy",
    (authFlow) => {
      const auth = createProviderAuthResolver(
        {},
        createAuthProfileStoreFixture({
          "openai:shared": {
            type: "oauth",
            provider: "openai",
            authFlow,
            access: "shared-access",
            refresh: "shared-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      );
      expect(auth("openai")).toMatchObject({
        mode: "oauth",
        authFlow,
        profileId: "openai:shared",
        discoveryApiKey: "shared-access",
      });
    },
  );

  it("resolves plugin-owned synthetic auth through the provider hook", () => {
    // Plugin-owned synthetic auth can provide discovery keys while persisted
    // config still records a non-secret marker.
    mockedResolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "xai-plugin-key",
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver(
      {} as NodeJS.ProcessEnv,
      createAuthProfileStoreFixture({}),
      {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key",
                },
              },
            },
          },
        },
      },
    );

    expect(auth("xai")).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: "xai-plugin-key",
      mode: "api_key",
      source: "none",
    });
  });

  function configuredVllmAuth(apiKey: string, env: NodeJS.ProcessEnv = {}) {
    return createProviderApiKeyResolver(env, createAuthProfileStoreFixture({}), {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://127.0.0.1:8000/v1",
            apiKey,
            api: "openai-completions",
            models: [],
          },
        },
      },
    });
  }

  it("resolves custom configured env markers for catalog discovery", () => {
    const auth = configuredVllmAuth("${MY_VLLM_KEY}", { MY_VLLM_KEY: "resolved-vllm-key" });

    expect(auth("vllm")).toEqual({
      apiKey: "MY_VLLM_KEY",
      discoveryApiKey: "resolved-vllm-key",
      mode: "api_key",
    });
  });

  it("does not send missing custom env markers as catalog discovery keys", () => {
    const auth = configuredVllmAuth("${MY_VLLM_KEY}");

    expect(auth("vllm")).toEqual({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
  });

  it("does not send missing known provider env markers as catalog discovery keys", () => {
    const auth = configuredVllmAuth("VLLM_API_KEY");

    expect(auth("vllm")).toEqual({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
  });

  it("preserves bare all-caps configured api keys as literal catalog discovery keys", () => {
    const auth = configuredVllmAuth("ALLCAPS_SAMPLE");

    expect(auth("vllm")).toEqual({
      apiKey: "ALLCAPS_SAMPLE",
      discoveryApiKey: "ALLCAPS_SAMPLE",
      mode: "api_key",
    });
  });

  it("preserves shared non-secret synthetic auth markers from provider hooks", () => {
    mockedResolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver(
      {} as NodeJS.ProcessEnv,
      createAuthProfileStoreFixture({}),
      {
        plugins: {
          entries: {
            lmstudio: {
              config: {
                models: [{ id: "qwen/qwen3.5-9b" }],
              },
            },
          },
        },
      },
    );

    expect(auth("lmstudio")).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      discoveryApiKey: undefined,
      mode: "api_key",
      source: "none",
    });
  });

  it.each(["api-key", "full-auth"] as const)(
    "keeps unresolved non-env refs sterile in the pure %s factory",
    (mode) => {
      const create = mode === "api-key" ? createProviderApiKeyResolver : createProviderAuthResolver;
      const auth = create({}, { version: 1, profiles: {} }, configWithKey(configRef));
      expect(auth("openai")).toEqual({
        apiKey: NON_ENV_SECRETREF_MARKER,
        discoveryApiKey: undefined,
        mode: "api_key",
        ...(mode === "full-auth" ? { source: "none" } : {}),
      });
    },
  );

  it("keeps synthetic markers in the mixed prepared credential map transport-free", async () => {
    const { createProviderApiKeyResolverFromPreparedCredentials } =
      await import("./models-config.providers.secrets.js");
    for (const key of [CUSTOM_LOCAL_AUTH_MARKER, NON_ENV_SECRETREF_MARKER]) {
      const auth = createProviderApiKeyResolverFromPreparedCredentials(
        { OPENAI_API_KEY: "unselected-env" },
        { openai: { type: "api_key", key } },
      );
      expect(auth("openai")).toEqual({ apiKey: key, discoveryApiKey: undefined, mode: "api_key" });
    }
  });
});

describe("models-config.providers.policy", () => {
  it("resolves config apiKey markers through provider plugin hooks", () => {
    const resolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");

    expect(resolver).toBeTypeOf("function");
    expect(resolver?.({ AWS_PROFILE: "default" } as NodeJS.ProcessEnv)).toBe("AWS_PROFILE");
  });

  it("normalizes Google provider config through provider plugin hooks", () => {
    expect(
      normalizeProviderSpecificConfig("google", {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        models: [],
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      models: [],
    });
  });

  it("does not treat generic transport APIs as provider plugin ids", () => {
    const provider = {
      api: "openai-completions" as const,
      baseUrl: "https://example.invalid/v1",
      apiKey: "GENERIC_TRANSPORT_MARKER",
      models: [],
    };

    const resolver = resolveProviderConfigApiKeyResolver("dashscope-vision", provider);
    expect(resolver).toBeTypeOf("function");
    expect(resolver?.({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(normalizeProviderSpecificConfig("dashscope-vision", provider)).toBe(provider);
  });
});
