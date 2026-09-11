import { describe, expect, it } from "vitest";
import {
  resolveConfigProviderUseBindings,
  setConfigProviderUseBindings,
} from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../auth-profiles/runtime-snapshots.js";
import { withSetupCredentialAccess } from "../auth-profiles/setup-access.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { getApiKeyForModelCore } from "../model-auth.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "../models-config.providers.secrets.js";
import { buildProviderAuthRecoveryHint } from "../provider-auth-recovery-hint.js";
import { resolveProviderUseAdmission } from "../provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import { resolvePreparedRuntimeModelAuth } from "./resolve-auth.js";

const sharedProviderEnvVars = {
  opencode: [{ pluginId: "opencode", envVars: ["OPENCODE_API_KEY"] }],
  "opencode-go": [{ pluginId: "opencode-go", envVars: ["OPENCODE_API_KEY"] }],
};
const byteplusMetadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "byteplus",
      providers: ["byteplus", "byteplus-plan"],
      setup: { providers: [{ id: "byteplus", envVars: ["BYTEPLUS_API_KEY"] }] },
      providerAuthAliases: { "byteplus-plan": "byteplus" },
    },
  ],
});

describe("resolveProviderUseAdmission", () => {
  it.each([
    ["amazon-bedrock", "amazon-bedrock-mantle"],
    ["amazon-bedrock-mantle", "amazon-bedrock"],
    ["fixture-target", "fixture-rival-alias"],
  ])(
    "rejects a generated %s binding after saved family account %s appears",
    async (provider, storedProvider) => {
      await withOpenClawTestState(
        {
          layout: "home",
          prefix: "startup-binding-family-",
          env: { SHARED_KEY: "environment-account" },
        },
        async (state) => {
          const metadataSnapshot = createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "target",
                providers: ["fixture-target"],
                setup: { providers: [{ id: "fixture-target", envVars: ["SHARED_KEY"] }] },
              },
              {
                id: "rival",
                providers: ["fixture-rival"],
                providerAuthAliases: { "fixture-rival-alias": "fixture-rival" },
                setup: { providers: [{ id: "fixture-rival", envVars: ["SHARED_KEY"] }] },
              },
            ],
          });
          const source: OpenClawConfig = {};
          setConfigProviderUseBindings(source, {
            [provider]:
              provider === "fixture-target"
                ? { apiKey: { source: "env", provider: "default", id: "SHARED_KEY" } }
                : {},
          });
          const config = resolveConfigProviderUseBindings(source);
          const profileId = `${storedProvider}:late`;
          const store: AuthProfileStore = {
            version: 1,
            runtimePersistedProfileIds: [profileId],
            profiles: {
              [profileId]: { type: "api_key", provider: storedProvider, key: "saved-account" },
            },
          };
          await withPluginMetadataSnapshotScope(
            metadataSnapshot,
            async () => {
              expect(() =>
                prepareAgentRuntimeAuth({
                  provider,
                  modelId: "fixture",
                  config,
                  env: state.env,
                  authProfileStore: store,
                  metadataSnapshot,
                }),
              ).toThrow(`conflicts with saved profile "${profileId}"`);
              expect(
                createModelAuthAvailabilityResolver({
                  cfg: config,
                  authStore: store,
                  env: state.env,
                  metadataSnapshot,
                }).evaluateProviderAuth(provider).availability,
              ).toBe(false);
            },
            { config },
          );
        },
      );
    },
  );

  it.each([
    "unchanged",
    "same-provider",
    "family-main",
    "family-other",
    "unrelated",
    "authored",
    "during-resolution",
    "runtime-only",
  ] as const)(
    "keeps startup binding authority current when a saved account is %s",
    async (selection) => {
      await withOpenClawTestState(
        {
          layout: "home",
          prefix: "startup-binding-account-",
          env: { BYTEPLUS_API_KEY: "environment-account" },
        },
        async (state) => {
          const binding = {
            apiKey: { source: "env" as const, provider: "default", id: "BYTEPLUS_API_KEY" },
          };
          const source: OpenClawConfig = {
            agents: {
              defaults: { model: "byteplus-plan/fixture" },
              entries: { main: {}, other: {} },
            },
            ...(selection === "authored"
              ? {
                  models: {
                    providers: { "byteplus-plan": { ...binding, baseUrl: "", models: [] } },
                  },
                }
              : {}),
          };
          const authoredSource = JSON.stringify(source);
          if (selection !== "authored") {
            setConfigProviderUseBindings(source, { "byteplus-plan": binding });
          }
          const config = resolveConfigProviderUseBindings(source);
          const store = ensureAuthProfileStore(state.agentDir(), {
            config,
            syncExternalCli: false,
          });
          setRuntimeAuthProfileStoreSnapshot(store, state.agentDir());
          setRuntimeAuthProfileStoreSnapshot(
            ensureAuthProfileStore(state.agentDir("other"), { config, syncExternalCli: false }),
            state.agentDir("other"),
          );
          const model: Model = {
            provider: "byteplus-plan",
            id: "fixture",
            name: "Fixture",
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 1024,
          };
          await withPluginMetadataSnapshotScope(
            byteplusMetadataSnapshot,
            async () => {
              const prepare = () =>
                prepareAgentRuntimeAuth({
                  provider: model.provider,
                  modelId: model.id,
                  modelApi: model.api,
                  modelBaseUrl: model.baseUrl,
                  config,
                  env: state.env,
                  authProfileStore: store,
                  agentDir: state.agentDir(),
                  metadataSnapshot: byteplusMetadataSnapshot,
                });
              const prepared = prepare();
              const resolve = () =>
                resolvePreparedRuntimeModelAuth({
                  plan: prepared.plan,
                  cfg: config,
                  model,
                  store,
                  agentDir: state.agentDir(),
                });
              expect((await resolve()).auth.apiKey).toBe("environment-account");
              const profileProvider =
                selection === "same-provider"
                  ? "byteplus-plan"
                  : selection === "unrelated"
                    ? "openai"
                    : "byteplus";
              const profileId = `${profileProvider}:late`;
              const saveAccount = () =>
                state.writeAuthProfiles(
                  {
                    version: 1,
                    profiles: {
                      [profileId]: {
                        type: "api_key",
                        provider: profileProvider,
                        key: "saved-account",
                      },
                    },
                  },
                  selection === "family-other" ? "other" : "main",
                );
              const message = `Startup provider binding for "byteplus-plan" conflicts with saved profile "${profileId}"`;
              if (selection === "runtime-only") {
                store.profiles[profileId] = {
                  type: "api_key",
                  provider: profileProvider,
                  key: "derived-runtime-account",
                };
                store.runtimePersistedProfileIds = [];
                setRuntimeAuthProfileStoreSnapshot(store, state.agentDir());
              } else if (selection === "during-resolution") {
                const rejected = expect(resolve()).rejects.toThrow(message);
                await saveAccount();
                await rejected;
              } else if (selection !== "unchanged") {
                await saveAccount();
              }
              const blocked = !["unchanged", "unrelated", "authored", "runtime-only"].includes(
                selection,
              );
              const evaluation = createModelAuthAvailabilityResolver({
                cfg: config,
                authStore: store,
                env: state.env,
                agentDir: state.agentDir(),
                metadataSnapshot: byteplusMetadataSnapshot,
              }).evaluateModelAuth(model.provider);
              expect(evaluation.availability).toBe(!blocked);
              if (blocked) {
                expect(prepare).toThrow(message);
                await expect(resolve()).rejects.toThrow(message);
                await expect(
                  getApiKeyForModelCore({ cfg: config, model, store, agentDir: state.agentDir() }),
                ).rejects.toThrow(message);
                expect(
                  buildProviderAuthRecoveryHint({
                    provider: model.provider,
                    config,
                    env: state.env,
                  }),
                ).toContain(profileId);
              } else {
                expect((await resolve()).auth.apiKey).toBe("environment-account");
              }
              expect(JSON.stringify(source)).toBe(authoredSource);
            },
            { config },
          );
        },
      );
    },
  );

  it("binds only a requested sibling to its saved credential realm", () => {
    expect(
      resolveProviderUseAdmission({
        env: { BYTEPLUS_API_KEY: "environment-account" },
        providerEnvVars: { byteplus: [{ pluginId: "byteplus", envVars: ["BYTEPLUS_API_KEY"] }] },
        profiles: { "byteplus:saved": { provider: "byteplus" } },
        requestedProviders: ["byteplus-plan"],
        storedCredentialAuthAliases: { "byteplus-plan": "byteplus", "byteplus-other": "byteplus" },
      }),
    ).toEqual(
      new Map([
        ["byteplus", { kind: "profile", profileId: "byteplus:saved" }],
        ["byteplus-plan", { kind: "profile", profileId: "byteplus:saved" }],
      ]),
    );
  });

  it.each(["primary", "fallback", "alias"])(
    "preserves the saved account for a %s-selected Plan instead of its environment key",
    (selection) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model:
              selection === "fallback"
                ? { primary: "byteplus/base-model", fallbacks: ["byteplus-plan/plan-model"] }
                : { primary: selection === "alias" ? "plan" : "byteplus-plan/plan-model" },
            models: { "byteplus-plan/plan-model": { alias: "plan" } },
          },
        },
      };
      const env = { BYTEPLUS_API_KEY: "environment-account" };
      const authProfileStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "byteplus:saved": { type: "api_key", provider: "byteplus", key: "saved-account" },
        },
      };
      const metadataSnapshot = byteplusMetadataSnapshot;
      expect(
        prepareAgentRuntimeAuth({
          provider: "byteplus-plan",
          modelId: "plan-model",
          config,
          env,
          authProfileStore,
          metadataSnapshot,
        }).attempts,
      ).toMatchObject([{ kind: "profile", profileId: "byteplus:saved" }]);
      expect(
        createModelAuthAvailabilityResolver({
          cfg: config,
          env,
          authStore: authProfileStore,
          metadataSnapshot,
        }).resolveProviderAuthAvailability("byteplus-plan"),
      ).toBe(true);
      const admission = resolveProviderUseAdmission({
        config,
        env,
        profiles: authProfileStore.profiles,
        requestedProviders: ["byteplus-plan"],
        storedCredentialAuthAliases: { "byteplus-plan": "byteplus" },
      });
      expect(
        createProviderApiKeyResolver(
          env,
          authProfileStore,
          config,
          undefined,
          undefined,
          env,
          admission,
        )("byteplus-plan").discoveryApiKey,
      ).toBe("saved-account");
      expect(
        createProviderAuthResolver(
          env,
          authProfileStore,
          config,
          undefined,
          undefined,
          env,
          admission,
        )("byteplus-plan"),
      ).toMatchObject({ profileId: "byteplus:saved", source: "profile" });
    },
  );

  it.each(["absent", "inactive", "expired"])(
    "does not replace an %s family account with an environment key for a selected Plan",
    (state) => {
      const authProfileStore: AuthProfileStore = {
        version: 1,
        profiles:
          state === "absent"
            ? {}
            : {
                "byteplus:saved":
                  state === "expired"
                    ? { type: "token", provider: "byteplus", token: "expired-account", expires: 1 }
                    : {
                        type: "api_key",
                        provider: "byteplus",
                        key: "inactive-account",
                        setup: {
                          replacement: true,
                          modelRef: "byteplus-plan/plan-model",
                          configJson: "{}",
                        },
                      },
              },
      };
      expect(() =>
        prepareAgentRuntimeAuth({
          provider: "byteplus-plan",
          modelId: "plan-model",
          config: {},
          env: { BYTEPLUS_API_KEY: "environment-account" },
          authProfileStore,
          metadataSnapshot: byteplusMetadataSnapshot,
        }),
      ).toThrow(
        state === "expired" ? "No usable bound auth profile" : "not configured for model use",
      );
    },
  );

  it("keeps exact-provider saved accounts ahead of family accounts", () => {
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "byteplus:family": { type: "api_key", provider: "byteplus", key: "family-account" },
        "byteplus-plan:saved": { type: "api_key", provider: "byteplus-plan", key: "plan-account" },
      },
    };
    const prepared = prepareAgentRuntimeAuth({
      provider: "byteplus-plan",
      modelId: "plan-model",
      config: {},
      env: { BYTEPLUS_API_KEY: "environment-account" },
      authProfileStore,
      metadataSnapshot: byteplusMetadataSnapshot,
    });
    expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["byteplus-plan:saved"]);
  });

  it("retains saved family account order and fallback without adding an environment attempt", () => {
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "byteplus:first": { type: "api_key", provider: "byteplus", key: "first-account" },
        "byteplus:second": { type: "api_key", provider: "byteplus", key: "second-account" },
      },
      order: { byteplus: ["byteplus:second", "byteplus:first"] },
    };
    const prepared = prepareAgentRuntimeAuth({
      provider: "byteplus-plan",
      modelId: "plan-model",
      config: {},
      env: { BYTEPLUS_API_KEY: "environment-account" },
      authProfileStore,
      metadataSnapshot: byteplusMetadataSnapshot,
    });
    expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual([
      "byteplus:second",
      "byteplus:first",
    ]);
  });

  it("keeps the environment account until a saved replacement is activated", async () => {
    const profileId = "anthropic:replacement";
    const env = { ANTHROPIC_API_KEY: "current-environment-key" };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: "anthropic",
          key: "replacement-key",
          setup: {
            replacement: true,
            modelRef: "anthropic/claude-sonnet-4-6",
            configJson: "{}",
          },
        },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          providers: ["anthropic"],
          setup: { providers: [{ id: "anthropic", envVars: ["ANTHROPIC_API_KEY"] }] },
        },
      ],
    });
    const prepare = () =>
      prepareAgentRuntimeAuth({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config: {},
        env,
        authProfileStore: store,
        metadataSnapshot,
      });

    expect(prepare().attempts).toMatchObject([{ kind: "direct" }]);
    const availability = createModelAuthAvailabilityResolver({
      cfg: {},
      env,
      authStore: store,
      metadataSnapshot,
    });
    expect(availability.resolveProviderAuthAvailability("anthropic")).toBe(true);

    await withSetupCredentialAccess({ profileId }, async () => {
      expect(prepare().attempts).toMatchObject([{ kind: "profile", profileId }]);
    });
    expect(prepare().attempts).toMatchObject([{ kind: "direct" }]);
  });

  it("does not replace an expired bound profile with shared environment auth", () => {
    const env = { OPENCODE_API_KEY: "unbound-key" };
    const store = {
      version: 1,
      profiles: {
        "opencode:expired": {
          provider: "opencode",
          type: "token" as const,
          token: "expired",
          expires: 1,
        },
        "opencode-go:other": {
          provider: "opencode-go",
          type: "api_key" as const,
          key: "other-key",
        },
      },
    };
    const admission = resolveProviderUseAdmission({ env, profiles: store.profiles });
    const apiKey = createProviderApiKeyResolver(
      env,
      store,
      {},
      undefined,
      undefined,
      env,
      admission,
    );
    const auth = createProviderAuthResolver(env, store, {}, undefined, undefined, env, admission);
    expect(apiKey("opencode").apiKey).toBeUndefined();
    expect(auth("opencode").mode).toBe("none");
    expect(apiKey("opencode-go").discoveryApiKey).toBe("other-key");
    const availability = createModelAuthAvailabilityResolver({ cfg: {}, env, authStore: store });
    expect(availability.resolveProviderAuthAvailability("opencode")).toBe(false);
    expect(availability.resolveProviderAuthAvailability("opencode-go")).toBe(true);
  });
  it("uses the admitted environment binding during catalog credential lookup", () => {
    const env = { OPENAI_API_KEY: "bound-key", CODEX_API_KEY: "unbound-key" };
    const resolve = createProviderApiKeyResolver(
      env,
      { version: 1, profiles: {} },
      {},
      undefined,
      undefined,
      env,
      new Map([["openai", { kind: "environment", envVar: "OPENAI_API_KEY" }]]),
    );
    expect(resolve("openai")).toMatchObject({
      apiKey: "OPENAI_API_KEY",
      discoveryApiKey: "bound-key",
    });
  });
  it("does not expose an auth-alias sibling through a stored family profile", () => {
    const resolver = createModelAuthAvailabilityResolver({
      cfg: {},
      env: {},
      authStore: {
        version: 1,
        profiles: {
          "family:account": { type: "api_key", provider: "family", key: "synthetic-key" },
        },
      },
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "family",
            providers: ["family", "family-plan"],
            providerAuthAliases: { "family-plan": "family" },
          },
        ],
      }),
    });
    expect(resolver.resolveProviderAuthAvailability("family")).toBe(true);
    expect(resolver.resolveProviderAuthAvailability("family-plan")).toBe(false);
  });
  it("admits only the normalized direct owner and records no credential value", () => {
    const admission = resolveProviderUseAdmission({
      env: { OWNER_API_KEY: "synthetic-secret", EMPTY_API_KEY: "  " },
      providerEnvVars: {
        " Owner ": [{ pluginId: "owner", envVars: ["OWNER_API_KEY"] }],
        owner: [{ pluginId: "owner", envVars: ["OWNER_API_KEY"] }],
        borrower: [],
        empty: [{ pluginId: "empty", envVars: ["EMPTY_API_KEY"] }],
      },
    });

    expect(admission).toEqual(
      new Map([["owner", { kind: "environment", envVar: "OWNER_API_KEY" }]]),
    );
  });

  it("does not choose either provider from a shared environment key", () => {
    expect(
      resolveProviderUseAdmission({
        env: { OPENCODE_API_KEY: "synthetic-shared-secret" },
        providerEnvVars: sharedProviderEnvVars,
      }),
    ).toEqual(new Map());
  });

  it.each([
    {
      kind: "provider-config",
      binding: {
        config: {
          models: {
            providers: { " OPENCODE ": { baseUrl: "https://models.example", models: [] } },
          },
        } satisfies OpenClawConfig,
      },
      source: { kind: "provider-config" },
    },
    {
      kind: "profile",
      binding: { profiles: { "saved-account": { provider: " OPENCODE " } } },
      source: { kind: "profile", profileId: "saved-account" },
    },
    {
      kind: "native-account",
      binding: { nativeProviders: new Set([" OPENCODE "]) },
      source: { kind: "native-account" },
    },
  ])("keeps shared credentials bound to the $kind provider", ({ binding, source }) => {
    const admission = resolveProviderUseAdmission({
      ...binding,
      env: { OPENCODE_API_KEY: "synthetic-shared-secret" },
      providerEnvVars: sharedProviderEnvVars,
    });

    expect(admission).toEqual(new Map([["opencode", source]]));
  });

  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "MODEL_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ])("does not admit a provider from generic credential %s", (envVar) => {
    expect(
      resolveProviderUseAdmission({
        env: { [envVar]: "synthetic-value" },
        providerEnvVars: { cloud: [{ pluginId: "cloud", envVars: [envVar] }] },
      }),
    ).toEqual(new Map());
  });

  it.each([undefined, "api-key", "aws-sdk"] as const)(
    "accepts an explicit %s provider without inline credentials",
    (auth) => {
      const admission = resolveProviderUseAdmission({
        config: {
          models: {
            providers: {
              cloud: { baseUrl: "https://models.example", auth, models: [] },
            },
          },
        },
        env: {},
        providerEnvVars: {},
      });

      expect(admission).toEqual(new Map([["cloud", { kind: "provider-config" }]]));
    },
  );
});
