import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "./cli-backends.test-support.js";
import { configFor, modelDefinition } from "./model-auth.fixtures.test-support.js";
import {
  authStore as makeAuthStore,
  harnessRegistry,
  oauth,
  snapshot,
} from "./model-catalog-fixtures.test-support.js";
import { prepareModelChoice } from "./model-runtime-choice.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import {
  getPreparedModelRuntimeAuthStore,
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { prepareConfiguredModelAliases } from "./prepared-model-runtime.configured-completion.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  loadProviderScopedThinkingCatalog: async () => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return published.owner.modelCatalog.entries;
  },
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return await read(published.owner);
  },
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
type ChoiceRequest = Parameters<typeof prepareModelChoice>[0];
const selection = { agentId: "main", raw: "fixture/new-model", source: "override" as const };

function expectChoice(config: OpenClawConfig, request: Partial<ChoiceRequest> = {}) {
  return expect(prepareModelChoice({ ...selection, cfg: config, ...request })).resolves;
}

function metadata(
  ...plugins: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>["plugins"]
) {
  return createPluginMetadataSnapshotFixture({ plugins });
}

const xaiPlugin = {
  id: "xai",
  providers: ["xai"],
  providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
};

function runtimeModel(
  model: PreparedModelRuntimeSnapshot["configuredRuntimeModels"][number]["model"],
) {
  return [{ provider: model.provider, modelId: model.id, model }];
}

const responseModel = (provider: string, id: string, baseUrl: string) =>
  makeProviderModelFixture<"openai-responses">({ provider, id, baseUrl, api: "openai-responses" });

function runtimeConfig(model: string, runtime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model, models: { [model]: runtime ? { agentRuntime: { id: runtime } } : {} } },
    },
  };
}

function providerRegistry(
  id: string,
  hooks: Omit<
    ReturnType<typeof createEmptyPluginRegistry>["providers"][number]["provider"],
    "id" | "label" | "auth"
  >,
) {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: id,
    source: "test",
    provider: { id, label: id, auth: [], ...hooks },
  });
  return registry;
}

function publish(
  isCurrent = () => true,
  config = cfg,
  facts: Parameters<typeof createModelRuntimeChoiceOwnerFixture>[2] &
    Pick<PreparedModelRuntimeSnapshot, "loadNativeModelCatalog"> = {},
) {
  const owner = createModelRuntimeChoiceOwnerFixture(config, isCurrent, facts);
  published.owner = owner;
  return owner;
}

function createSpawnReachingGateway(config: OpenClawConfig) {
  const callGateway = vi.fn(async () => {
    throw new Error("Reached session creation");
  });
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config,
    callGateway,
    registerRun: vi.fn(),
    countActiveRuns: () => 0,
  });
  return { callGateway, tool };
}

function renderPublishedAliases(owner: PreparedModelRuntimeSnapshot) {
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    throw new Error("Expected prepared fixture accounts");
  }
  const { authStorage, modelRegistry } = owner.createStores();
  const configuredModelAliases = prepareConfiguredModelAliases(
    {
      input: {
        config: owner.config,
        agentId: owner.agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
      },
      env: {},
      authStore,
      templateAuthStorage: authStorage,
      credentials: {},
      providerIds: [...new Set(owner.configuredRuntimeModels.map(({ provider }) => provider))],
      configuredModelRefs: owner.configuredRuntimeModels.map(({ provider, modelId }) => ({
        provider,
        modelId,
      })),
      configuredRuntimeModels: owner.configuredRuntimeModels,
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
    },
    {
      pluginMetadataSnapshot: owner.metadataSnapshot,
      pluginRegistry: owner.pluginRegistry,
      inlineProviderModels: [],
      remoteCatalog: null,
      configuredCatalogEntries: owner.modelCatalog.entries,
    },
    modelRegistry,
    owner.configuredRuntimeModels,
  );
  return buildConfiguredAgentSystemPrompt({
    config: owner.config,
    agentId: owner.agentId,
    workspaceDir: owner.workspaceDir ?? "/tmp/runtime-choice",
    preparedModelRuntime: { ...owner, configuredModelAliases },
  });
}

describe("prepared model support admission", () => {
  const custom: OpenClawConfig = {
    ...cfg,
    ...configFor("fixture", "https://custom.invalid/v1", { api: "openai-completions" }),
  };

  const manualPolicy: OpenClawConfig = {
    ...custom,
    agents: { defaults: { modelPolicy: { allow: ["fixture/manual-only"] } } },
  };
  it.each([
    { visible: false, agentPolicy: undefined, policyPath: "agents.defaults.modelPolicy.allow" },
    {
      visible: true,
      agentPolicy: { allow: ["fixture/agent-only"] },
      policyPath: "agents.entries.*.modelPolicy.allow",
    },
  ])(
    "explains $policyPath before creating a child",
    async ({ visible, agentPolicy, policyPath }) => {
      await withTestDir({ prefix: "openclaw-spawn-policy-" }, async (dir) => {
        const config: OpenClawConfig = {
          ...manualPolicy,
          session: { store: path.join(dir, "sessions.json") },
          agents: {
            ...manualPolicy.agents,
            entries: { main: { workspace: dir, modelPolicy: agentPolicy } },
          },
        };
        publish(() => true, config, { agentDir: path.join(dir, "agent"), workspaceDir: dir });
        const { callGateway, tool } = createSpawnReachingGateway(config);
        setRuntimeConfigSnapshot(config);
        try {
          const result = await tool.execute("policy-refusal", {
            task: "test",
            model: "fixture/new-model",
            visible,
          });
          expect(result.details).toMatchObject({
            status: "error",
            error: expect.stringContaining(
              `model not allowed: fixture/new-model. Rejected by ${policyPath}.`,
            ),
          });
          expect(result.details).toMatchObject({
            error: expect.stringContaining("Add the model or its provider wildcard"),
          });
          expect(callGateway).not.toHaveBeenCalled();
        } finally {
          clearRuntimeConfigSnapshot();
        }
      });
    },
  );
  const inheritedRef = { provider: "fixture", model: "fixture/custom-model" };
  it.each([
    {
      name: "preserves an inherited provider-prefixed model id",
      current: true,
      config: custom,
      request: {
        raw: "fixture/fixture/custom-model",
        source: "automatic" as const,
        resolvedRef: inheritedRef,
      },
      expected: {
        kind: "resolved",
        ref: inheritedRef,
        model: { id: inheritedRef.model, baseUrl: "https://custom.invalid/v1" },
      },
    },
    {
      name: "does not replace a missing pinned account with the shared account",
      current: true,
      config: custom,
      request: { raw: "fixture/new-model@missing" },
      expected: { kind: "unavailable", error: expect.stringContaining("selected account") },
    },
    {
      name: "does not publish a choice from a replaced generation",
      current: false,
      config: custom,
      request: {},
      expected: { kind: "unavailable", error: expect.stringContaining("changed during selection") },
    },
  ])("$name", async ({ current, config, request, expected }) => {
    publish(() => current, config);
    await expectChoice(config, request).toMatchObject(expected);
  });

  it("rejects an unsupported explicit selection even with a viable fallback", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          ...custom.models?.providers,
          xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [] },
        },
      },
    };
    publish(() => true, config, {
      metadataSnapshot: metadata(xaiPlugin),
    });
    await expectChoice(config, {
      raw: "xai/nonexistent-native-fixture",
      fallbacks: ["fixture/custom-unlisted"],
    }).toMatchObject({ kind: "unavailable", error: expect.stringContaining("Unknown model") });
  });

  it.each([
    { model: "current", ambiguous: false, admitted: true, authored: false },
    { model: "current", ambiguous: false, admitted: true, authored: true },
    { model: "auto", ambiguous: false, admitted: false, authored: false },
    { model: "current", ambiguous: true, admitted: false, authored: false },
  ])(
    "checks the native donor before visible alias creation: $model/$ambiguous/$authored",
    async (testCase) => {
      await withTestDir({ prefix: "openclaw-native-alias-" }, async (dir) => {
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: dir } },
            defaults: { modelPolicy: { allow: [] } },
          },
          session: { store: path.join(dir, "sessions.json") },
          ...configFor("personal", "https://api.x.ai/v1", {
            api: "openai-responses",
            models: testCase.authored
              ? [
                  modelDefinition(testCase.model, {
                    compat: { codeMode: "capable" },
                    cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
                  }),
                ]
              : [],
          }),
        };
        const catalog = {
          api: "openai-responses" as const,
          baseUrl: "https://api.x.ai/v1",
          models: [
            { id: "current", name: "Current", compat: { codeMode: "preferred" as const } },
            { id: "auto", name: "Retired" },
          ],
        };
        const owner = publish(() => true, config, {
          agentDir: path.join(dir, "agent"),
          workspaceDir: dir,
          metadataSnapshot: metadata(
            {
              ...xaiPlugin,
              modelCatalog: {
                discovery: { xai: "static" },
                providers: { xai: catalog },
                suppressions: [
                  {
                    provider: "xai",
                    model: "auto",
                    reason: "Retired selector",
                    retirement: { replacedBy: "current" },
                    when: { baseUrlHosts: ["api.x.ai"] },
                  },
                ],
              },
            },
            ...(testCase.ambiguous
              ? [
                  {
                    id: "second-owner",
                    providers: ["second-native"],
                    modelCatalog: {
                      discovery: { "second-native": "static" as const },
                      providers: { "second-native": catalog },
                    },
                  },
                ]
              : []),
          ),
        });
        bindPreparedModelRuntimeAuth(owner, {
          store: {
            version: 1,
            profiles: { personal: { provider: "personal", type: "api_key", key: "synthetic-key" } },
          },
        });
        const { callGateway, tool } = createSpawnReachingGateway(config);
        const model = `personal/${testCase.model}`;
        if (testCase.authored && testCase.admitted) {
          await expectChoice(config, { raw: model }).toMatchObject({
            kind: "resolved",
            model: {
              compat: { codeMode: "capable" },
              cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
            },
          });
        }
        const result = tool.execute("native-alias", { task: "test", model, visible: true });
        if (testCase.admitted) {
          await expect(result).rejects.toThrow("Reached session creation");
          expect(callGateway).toHaveBeenCalledExactlyOnceWith(
            "sessions.create",
            expect.objectContaining({ model }),
          );
        } else {
          expect((await result).details).toMatchObject({ status: "error" });
          expect(callGateway).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("does not lend a native descriptor to another native endpoint", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      ...configFor("fixture", "https://b.native.invalid/v1", { api: "openai-responses" }),
    };
    publish(() => true, config, {
      metadataSnapshot: metadata({
        id: "fixture",
        providers: ["fixture"],
        providerEndpoints: [
          { endpointClass: "xai-native", hosts: ["a.native.invalid"] },
          { endpointClass: "groq-native", hosts: ["b.native.invalid"] },
        ],
      }),
      configuredRuntimeModels: runtimeModel(
        responseModel("fixture", "model", "https://a.native.invalid/v1"),
      ),
    });
    await expectChoice(config, { raw: "fixture/model" }).toMatchObject({ kind: "unavailable" });
  });

  it("does not advertise an inline model whose catalog alias has competing owners", async () => {
    const provider = "azure-openai-responses";
    const model = makeProviderModelFixture<"azure-openai-responses">({
      provider,
      id: "deployment",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
    const config: OpenClawConfig = {
      plugins: { entries: { "workspace-override": { enabled: true } } },
      ...configFor(provider, model.baseUrl, { api: "azure-openai-responses", models: [model] }),
      agents: { defaults: { models: { [`${provider}/deployment`]: { alias: "Azure" } } } },
    };
    const owner = publish(() => true, config, {
      configuredRuntimeModels: runtimeModel(model),
      metadataSnapshot: metadata(
        {
          id: "openai",
          origin: "bundled",
          enabledByDefault: true,
          providers: ["openai"],
          modelCatalog: {
            aliases: { [provider]: { provider: "openai", api: "azure-openai-responses" } },
          },
        },
        {
          id: "workspace-override",
          origin: "workspace",
          providers: ["github-copilot"],
          modelCatalog: { aliases: { [provider]: { provider: "github-copilot" } } },
        },
      ),
    });
    await expectChoice(config, {
      raw: `${provider}/deployment`,
      source: "automatic",
    }).toMatchObject({ kind: "unavailable" });
    expect(renderPublishedAliases(owner)).not.toContain(`- Azure: ${provider}/deployment`);
  });

  it("defers unobserved dynamic models but keeps known suppressions final", async () => {
    const config: OpenClawConfig = {};
    const dynamicModel = responseModel("fixture", "new-model", "https://dynamic.invalid/v1");
    const prepareDynamicModel = vi.fn(async () => dynamicModel);
    const registry = providerRegistry("fixture", { prepareDynamicModel });
    const owner = publish(() => true, config, {
      pluginRegistry: registry,
      metadataSnapshot: metadata({
        id: "fixture",
        providers: ["fixture"],
        modelCatalog: {
          suppressions: [
            { provider: "fixture", model: "retired", reason: "Retired fixture model" },
          ],
        },
      }),
    });
    await expectChoice(config, { source: "automatic" }).toMatchObject({
      kind: "pending",
      ref: { provider: "fixture", model: "new-model" },
    });
    const retired = {
      kind: "unavailable",
      error: expect.stringContaining("Retired fixture model"),
    };
    const automaticRetired = { source: "automatic" as const, raw: "fixture/retired" };
    await expectChoice(config, automaticRetired).toMatchObject(retired);
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    await expectChoice(config).toMatchObject({
      kind: "resolved",
      ref: { provider: "fixture", model: "new-model" },
      model: dynamicModel,
    });
    const incompleteConfig: OpenClawConfig = configFor("fixture", "https://dynamic.invalid/v1", {
      models: [modelDefinition("retired")],
    });
    publish(() => true, incompleteConfig, {
      pluginRegistry: registry,
      metadataSnapshot: owner.metadataSnapshot,
    });
    await expectChoice(incompleteConfig, automaticRetired).toMatchObject(retired);
    expect(prepareDynamicModel).toHaveBeenCalledOnce();
  });

  function retiredXaiOwner(
    modelBaseUrl = "https://api.x.ai/v1",
    facts: Partial<
      Pick<PreparedModelRuntimeSnapshot, "pluginRegistry" | "agentDir" | "workspaceDir">
    > = {},
  ) {
    const model = responseModel("xai", "auto", modelBaseUrl);
    const config: OpenClawConfig = {
      ...custom,
      agents: { defaults: { models: { "xai/auto": { alias: "Grok" } } } },
      models: {
        providers: {
          ...custom.models?.providers,
          xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [model] },
        },
      },
    };
    return publish(() => true, config, {
      ...facts,
      configuredRuntimeModels: runtimeModel(model),
      metadataSnapshot: metadata({
        ...xaiPlugin,
        modelCatalog: {
          suppressions: [
            {
              provider: "xai",
              model: "auto",
              reason: "Retired native selector",
              retirement: { replacedBy: "grok-4.6" },
              when: { baseUrlHosts: ["api.x.ai"] },
            },
          ],
        },
      }),
    });
  }

  it("keeps a retired primary local to the automatic plan", async () => {
    const owner = retiredXaiOwner();
    const raw = "xai/auto";
    const ref = { provider: "xai", model: "auto" };
    const automatic = { raw, source: "automatic" as const };
    await expectChoice(owner.config, {
      ...automatic,
      fallbacks: ["fixture/custom-unlisted"],
    }).toMatchObject({ kind: "automatic", ref });
    await expectChoice(owner.config, {
      ...automatic,
      fallbacks: ["xai/auto"],
    }).toMatchObject({ kind: "unavailable" });
  });

  it("admits a visible spawn past a retired runtime-preferred fallback", async () => {
    await withTestDir({ prefix: "openclaw-retired-spawn-fallback-" }, async (dir) => {
      const registry = providerRegistry("xai", {
        preferRuntimeResolvedModel: ({ modelId }) => modelId === "auto",
        resolveDynamicModel: ({ modelId }) =>
          modelId === "auto" ? responseModel("xai", modelId, "https://api.x.ai/v1") : undefined,
      });
      const owner = retiredXaiOwner(undefined, {
        pluginRegistry: registry,
        agentDir: path.join(dir, "agent"),
        workspaceDir: dir,
      });
      const config = owner.config;
      config.session = { store: path.join(dir, "sessions.json") };
      config.agents = {
        entries: { main: { workspace: dir } },
        defaults: {
          modelPolicy: { allow: [] },
          subagents: {
            model: { primary: "xai/unknown-primary", fallbacks: ["xai/auto", "fixture/custom"] },
          },
        },
      };
      const { callGateway, tool } = createSpawnReachingGateway(config);
      await expect(
        tool.execute("retired-fallback", { task: "test", visible: true }),
      ).rejects.toThrow("Reached session creation");
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        "sessions.create",
        expect.objectContaining({ model: "xai/unknown-primary" }),
      );
    });
  });

  it("uses final inline transport for admission and alias publication", async () => {
    const owner = retiredXaiOwner("https://custom.invalid/v1");
    await expectChoice(owner.config, { raw: "xai/auto" }).toMatchObject({ kind: "resolved" });
    expect(renderPublishedAliases(owner)).toContain("- Grok: xai/auto");
  });

  it("uses provider transport normalization for explicit, automatic and published aliases without discovery", async () => {
    const model = responseModel("xai", "grok-4.6", "https://api.x.ai/v1");
    const config: OpenClawConfig = {
      agents: { defaults: { models: { "xai/grok-4.6": { alias: "Grok" } } } },
      ...configFor("xai", model.baseUrl, { api: "openai-completions" }),
    };
    const prepareDynamicModel = vi.fn(async () => undefined);
    const registry = providerRegistry("xai", {
      prepareDynamicModel,
      normalizeTransport: () => ({ api: "openai-responses", baseUrl: model.baseUrl }),
    });
    const owner = publish(() => true, config, {
      pluginRegistry: registry,
      configuredRuntimeModels: runtimeModel(model),
      metadataSnapshot: metadata(xaiPlugin),
    });
    const request = { raw: "xai/grok-4.6" };
    const resolved = {
      kind: "resolved",
      model: { api: "openai-responses", baseUrl: model.baseUrl },
    };
    await expectChoice(config, { ...request, source: "automatic" }).toMatchObject(resolved);
    expect(renderPublishedAliases(owner)).toContain("- Grok: xai/grok-4.6");
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    await expectChoice(config, request).toMatchObject(resolved);
  });

  it("does not certify a Platform-only model on a pinned subscription route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      ...configFor("openai", "https://chatgpt.com/backend-api/codex", {
        api: "openai-chatgpt-responses",
      }),
    };
    const row = {
      provider: "openai",
      id: "chat-latest",
      name: "Platform chat",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const owner = publish(() => true, config, {
      modelCatalog: snapshot([row]),
    });
    bindPreparedModelRuntimeAuth(owner, {
      store: makeAuthStore({ oauth: oauth("openai", 9_999_999_999_999) }),
    });
    await expectChoice(config, { raw: "openai/chat-latest@oauth" }).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("only through OpenAI Platform"),
    });
  });

  const nativeRow = {
    provider: "fixture",
    id: "native",
    name: "Native model",
    nativeRuntime: "native-test",
  };
  const nativeResolved = { kind: "resolved", ref: { provider: "fixture", model: "native" } };
  const nativeRenewal = { provider: "fixture", modelId: "native", runtime: "native-test" };
  // The shared runtime client stays registered until another agent's turn retires it; only the
  // owner's native load can register its replacement and return a renewed catalog.
  function publishNativeRenewal(
    config: OpenClawConfig,
    { isCurrent = () => true, row = nativeRow }: { isCurrent?: () => boolean; row?: object } = {},
  ) {
    const state = {
      registered: true,
      renewalRegisters: true,
      renewed: {
        entries: [row],
        routeVariants: [row],
      } as PreparedModelRuntimeSnapshot["modelCatalog"],
    };
    const reload = vi.fn(async () => {
      state.registered = state.renewalRegisters;
      return state.renewed;
    });
    const registry = harnessRegistry("native-test", {
      label: "Native test",
      authBootstrap: "harness",
      readModelCatalogReadiness: () =>
        state.registered ? { accountType: "subscription", authMode: "oauth" } : undefined,
    });
    const owner = publish(isCurrent, config, {
      pluginRegistry: registry,
      loadNativeModelCatalog: reload,
      modelCatalog: state.renewed,
      configuredRuntimeModels: runtimeModel(
        responseModel("fixture", "native", "https://native.invalid/v1"),
      ),
    });
    bindPreparedModelRuntimeAuth(owner, { store: makeAuthStore() });
    return { state, reload };
  }
  // The runtime comes from the catalog row, so only the renewed catalog decides admission.
  const implicitNative = runtimeConfig("fixture/native");

  it.each(["anthropic", "claude-cli"])(
    "rechecks recovered native auth before admitting %s without a catalog refresh",
    async (provider) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: createClaudeCliBackends,
      });
      try {
        const raw = `${provider}/claude-opus-5-5`;
        const config = runtimeConfig(raw, "claude-cli");
        const row = { provider, id: "claude-opus-5-5", name: "Claude" };
        const owner = publish(() => true, config, {
          modelCatalog: snapshot([row]),
          configuredRuntimeModels: runtimeModel(
            makeProviderModelFixture({
              provider,
              id: row.id,
              api: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
            }),
          ),
          metadataSnapshot: metadata({
            id: "anthropic",
            providers: ["anthropic"],
            cliBackends: ["claude-cli"],
          }),
        });
        const recheckNativeLogin = vi.fn(async () => {
          await Promise.resolve();
          Object.assign(owner, { authModes: { "claude-cli": "api_key" } });
        });
        Object.assign(owner, { recheckNativeLogin });
        await expectChoice(config, { raw }).toMatchObject({
          kind: "resolved",
          ref: { provider, model: "claude-opus-5-5" },
        });
        expect(recheckNativeLogin).toHaveBeenCalledExactlyOnceWith({ force: true });
      } finally {
        cliBackendsTesting.resetDepsForTest();
      }
    },
  );

  it.each([
    { ownership: "catalog", source: "override" },
    { ownership: "configured", source: "override" },
  ] as const)(
    "renews $ownership native ownership once per $source choice without host credentials",
    async ({ ownership, source }) => {
      const configured = ownership === "configured";
      const config = configured ? runtimeConfig("fixture/native", "native-test") : implicitNative;
      // Configured ownership must renew without a row-owned runtime.
      const { nativeRuntime: _, ...configuredRow } = nativeRow;
      const { state, reload } = publishNativeRenewal(config, {
        row: configured ? configuredRow : nativeRow,
      });
      const choose = (raw = "fixture/native") =>
        prepareModelChoice({ ...selection, source, cfg: config, raw });
      expect(await choose()).toMatchObject(nativeResolved);
      expect(reload).not.toHaveBeenCalled();
      state.registered = false;
      expect(await choose()).toMatchObject(nativeResolved);
      expect(reload).toHaveBeenCalledExactlyOnceWith(nativeRenewal);
      state.registered = false;
      state.renewalRegisters = false;
      expect(await choose()).toMatchObject(
        configured
          ? { kind: "unavailable" }
          : { kind: "unavailable", error: expect.stringContaining("Restore that account") },
      );
      expect(reload).toHaveBeenCalledTimes(2);
      if (configured) {
        reload.mockRejectedValueOnce(new Error("renewal failed"));
        expect(await choose()).toMatchObject({ kind: "unavailable" });
        expect(reload).toHaveBeenCalledTimes(3);
        return;
      }
      // The load restored the client, but its catalog moved the model to a runtime without
      // readiness. The renewed catalog decides, not the stale owner row.
      state.registered = false;
      state.renewalRegisters = true;
      const moved = { ...nativeRow, nativeRuntime: "native-retired" };
      state.renewed = { entries: [moved], routeVariants: [moved] };
      expect(await choose()).toMatchObject({ kind: "unavailable" });
      expect(reload).toHaveBeenCalledTimes(3);
      // A failed load is the rejection's cause; a missing account is not implied.
      state.registered = false;
      reload.mockRejectedValueOnce(new Error("account/read timed out"));
      const failed = await choose();
      expect(failed).toMatchObject({
        kind: "unavailable",
        error: expect.stringContaining("native catalog renewal failed: account/read timed out"),
      });
      expect(failed).not.toMatchObject({ error: expect.stringContaining("Restore that account") });
      expect(reload).toHaveBeenCalledTimes(4);
      // A pinned account keeps its host evaluation, so it never renews native readiness.
      expect(await choose("fixture/native@fixture:account")).toMatchObject({ kind: "unavailable" });
      expect(reload).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    { revoked: "model", source: "override" },
    { revoked: "owner", source: "automatic" },
  ] as const)(
    "rejects $source admission when native renewal revokes the $revoked",
    async ({ revoked, source }) => {
      let current = true;
      const { state, reload } = publishNativeRenewal(implicitNative, { isCurrent: () => current });
      state.registered = false;
      if (revoked === "model") {
        state.renewed = { entries: [], routeVariants: [] };
      } else {
        reload.mockImplementationOnce(async () => {
          // A new generation replaces this owner while renewal registers the client.
          current = false;
          state.registered = true;
          return state.renewed;
        });
      }
      await expectChoice(implicitNative, { source, raw: "fixture/native" }).toMatchObject({
        kind: "unavailable",
      });
      expect(reload).toHaveBeenCalledExactlyOnceWith(nativeRenewal);
    },
  );
});
