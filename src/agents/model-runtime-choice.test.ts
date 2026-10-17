import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
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
function currentOwner() {
  if (!published.owner) {
    throw new Error("No published test model owner");
  }
  return published.owner;
}
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  loadProviderScopedThinkingCatalog: async () => currentOwner().modelCatalog.entries,
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    return await read(currentOwner());
  },
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const xaiUrl = "https://api.x.ai/v1";
const unavailable = (error?: string) => ({
  kind: "unavailable",
  ...(error ? { error: expect.stringContaining(error) } : {}),
});
const xaiPlugin: Parameters<typeof metadata>[number] = {
  id: "xai",
  providers: ["xai"],
  providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
};
function providerRegistry(id: string, hooks: Partial<ProviderPlugin>, label = "Fixture") {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: id,
    source: "test",
    provider: { id, label, auth: [], ...hooks },
  });
  return registry;
}
function buildModel(provider: string, id: string, baseUrl: string, api = "openai-responses") {
  return makeProviderModelFixture({ provider, id, baseUrl, api });
}
function modelDefinition(id: string): ModelProviderConfig["models"][number] {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
function configuredModel(provider: string, id: string, baseUrl: string, api?: string) {
  return [{ provider, modelId: id, model: buildModel(provider, id, baseUrl, api) }];
}
const selection = { agentId: "main", raw: "fixture/new-model", source: "override" as const };
type ChoiceOptions = Partial<Parameters<typeof prepareModelChoice>[0]>;
const chooseModel = (config: OpenClawConfig, options: ChoiceOptions = {}) =>
  prepareModelChoice({ ...selection, cfg: config, ...options });
const expectChoice = async (config: OpenClawConfig, options: ChoiceOptions, expected: object) =>
  expect(await chooseModel(config, options)).toMatchObject(expected);
const modelCatalog = (row: PreparedModelRuntimeSnapshot["modelCatalog"]["entries"][number]) => ({
  entries: [row],
  routeVariants: [row],
});
const runtimeConfig = (raw: string, runtime?: string): OpenClawConfig => ({
  agents: {
    defaults: { model: raw, models: { [raw]: runtime ? { agentRuntime: { id: runtime } } : {} } },
  },
});
function metadata(
  ...plugins: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>["plugins"]
) {
  return createPluginMetadataSnapshotFixture({ plugins });
}
function nativeSuppression(reason: string, replacedBy: string) {
  return {
    provider: "xai",
    model: "auto",
    reason,
    retirement: { replacedBy },
    when: { baseUrlHosts: ["api.x.ai"] },
  };
}
function bindProfiles(
  owner: PreparedModelRuntimeSnapshot,
  profiles: NonNullable<Parameters<typeof bindPreparedModelRuntimeAuth>[1]["store"]>["profiles"],
) {
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles } });
}
function providerConfig(
  provider: string,
  value: ModelProviderConfig | string,
  base: OpenClawConfig = cfg,
): OpenClawConfig {
  const config =
    typeof value === "string"
      ? { api: "openai-responses" as const, baseUrl: value, models: [] }
      : value;
  return {
    ...base,
    models: { ...base.models, providers: { ...base.models?.providers, [provider]: config } },
  };
}
function spawnFixture(config: OpenClawConfig) {
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

function renderPublishedAliases(owner: PreparedModelRuntimeSnapshot) {
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    throw new Error("Expected prepared fixture accounts");
  }
  const { authStorage, modelRegistry } = owner.createStores();
  const configuredModelAliases = prepareConfiguredModelAliases(
    {
      input: owner,
      env: {},
      authStore,
      templateAuthStorage: authStorage,
      credentials: {},
      providerIds: [...new Set(owner.configuredRuntimeModels.map(({ provider }) => provider))],
      configuredModelRefs: owner.configuredRuntimeModels,
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
  const custom = providerConfig("fixture", {
    api: "openai-completions",
    baseUrl: "https://custom.invalid/v1",
    models: [],
  });

  const manualPolicy: OpenClawConfig = {
    ...custom,
    agents: { defaults: { modelPolicy: { allow: ["fixture/manual-only"] } } },
  };
  const inheritedRef = { provider: "fixture", model: "fixture/custom-model" };
  it.each<[string, ChoiceOptions, object, OpenClawConfig?, boolean?]>([
    [
      "inherited provider-prefixed id",
      {
        raw: "fixture/fixture/custom-model",
        source: "automatic",
        resolvedRef: inheritedRef,
      },
      {
        kind: "resolved",
        ref: inheritedRef,
        model: { id: inheritedRef.model, baseUrl: "https://custom.invalid/v1" },
      },
    ],
    [
      "manual override policy",
      {},
      { kind: "unavailable", error: "model not allowed: fixture/new-model" },
      manualPolicy,
    ],
    [
      "missing pinned account",
      { raw: "fixture/new-model@missing" },
      unavailable("selected account"),
    ],
    ["replaced generation", {}, unavailable("changed during selection"), custom, false],
  ])("checks %s", async (_name, request, expected, config = custom, current = true) => {
    publish(() => current, config);
    expect(await chooseModel(config, request)).toMatchObject(expected);
  });

  it("rejects an unsupported explicit selection even with a viable fallback", async () => {
    const config = providerConfig("xai", xaiUrl, custom);
    publish(() => true, config, {
      metadataSnapshot: metadata(xaiPlugin),
    });
    await expectChoice(
      config,
      {
        raw: "xai/nonexistent-native-fixture",
        fallbacks: ["fixture/custom-unlisted"],
      },
      unavailable("Unknown model"),
    );
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
        const personal: ModelProviderConfig = {
          api: "openai-responses",
          baseUrl: xaiUrl,
          models: testCase.authored
            ? [
                {
                  ...modelDefinition(testCase.model),
                  compat: { codeMode: "capable" },
                  cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
                },
              ]
            : [],
        };
        const config = providerConfig("personal", personal, {
          agents: {
            entries: { main: { workspace: dir } },
            defaults: { modelPolicy: { allow: [] } },
          },
          session: { store: path.join(dir, "sessions.json") },
        });
        const catalog = {
          api: "openai-responses" as const,
          baseUrl: xaiUrl,
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
                suppressions: [nativeSuppression("Retired selector", "current")],
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
        bindProfiles(owner, {
          personal: { provider: "personal", type: "api_key", key: "synthetic-key" },
        });
        const { callGateway, tool } = spawnFixture(config);
        const model = `personal/${testCase.model}`;
        if (testCase.authored && testCase.admitted) {
          expect(await chooseModel(config, { raw: model })).toMatchObject({
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
    const config = providerConfig("fixture", "https://b.native.invalid/v1");
    publish(() => true, config, {
      metadataSnapshot: metadata({
        id: "fixture",
        providers: ["fixture"],
        providerEndpoints: [
          { endpointClass: "xai-native", hosts: ["a.native.invalid"] },
          { endpointClass: "groq-native", hosts: ["b.native.invalid"] },
        ],
      }),
      configuredRuntimeModels: configuredModel("fixture", "model", "https://a.native.invalid/v1"),
    });
    expect(await chooseModel(config, { raw: "fixture/model" })).toMatchObject({
      kind: "unavailable",
    });
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
      models: {
        providers: {
          [provider]: { api: "azure-openai-responses", baseUrl: model.baseUrl, models: [model] },
        },
      },
      agents: { defaults: { models: { [`${provider}/deployment`]: { alias: "Azure" } } } },
    };
    const owner = publish(() => true, config, {
      configuredRuntimeModels: [{ provider, modelId: model.id, model }],
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
    const { withPluginRuntimeGenerationScope } =
      await import("../plugins/runtime/generation-scope.js");
    const { resolveManifestModelCatalogProviderAliasMetadata } =
      await import("./embedded-agent-runner/model.manifest-alias.js");
    expect(
      withPluginRuntimeGenerationScope(owner, () =>
        resolveManifestModelCatalogProviderAliasMetadata({
          provider,
          modelId: model.id,
          cfg: config,
        }),
      ),
    ).toMatchObject({ ambiguous: true });
    await expectChoice(
      config,
      { raw: `${provider}/deployment`, source: "automatic" },
      unavailable(),
    );
    expect(renderPublishedAliases(owner)).not.toContain(`- Azure: ${provider}/deployment`);
  });

  it("defers unobserved dynamic models but keeps known suppressions final", async () => {
    const config: OpenClawConfig = {};
    const dynamicModel = buildModel("fixture", "new-model", "https://dynamic.invalid/v1");
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
    expect(await chooseModel(config, { source: "automatic" })).toMatchObject({
      kind: "pending",
      ref: { provider: "fixture", model: "new-model" },
    });
    await expectChoice(
      config,
      { source: "automatic", raw: "fixture/retired" },
      unavailable("Retired fixture model"),
    );
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    expect(await chooseModel(config, {})).toMatchObject({
      kind: "resolved",
      ref: { provider: "fixture", model: "new-model" },
      model: dynamicModel,
    });
    expect(prepareDynamicModel).toHaveBeenCalledOnce();
    const incompleteConfig = providerConfig(
      "fixture",
      {
        baseUrl: "https://dynamic.invalid/v1",
        models: [{ ...modelDefinition("retired"), maxTokens: 1024 }],
      },
      {},
    );
    publish(() => true, incompleteConfig, {
      pluginRegistry: registry,
      metadataSnapshot: owner.metadataSnapshot,
    });
    await expectChoice(
      incompleteConfig,
      { source: "automatic", raw: "fixture/retired" },
      unavailable("Retired fixture model"),
    );
    expect(prepareDynamicModel).toHaveBeenCalledOnce();
  });

  function retiredXaiOwner(
    modelBaseUrl = xaiUrl,
    facts: Partial<
      Pick<PreparedModelRuntimeSnapshot, "pluginRegistry" | "agentDir" | "workspaceDir">
    > = {},
  ) {
    const descriptor = buildModel("xai", "auto", modelBaseUrl);
    const config: OpenClawConfig = {
      ...custom,
      agents: { defaults: { models: { "xai/auto": { alias: "Grok" } } } },
      models: {
        providers: {
          ...custom.models?.providers,
          xai: { api: "openai-responses", baseUrl: xaiUrl, models: [modelDefinition("auto")] },
        },
      },
    };
    return publish(() => true, config, {
      ...facts,
      configuredRuntimeModels: [{ provider: "xai", modelId: "auto", model: descriptor }],
      metadataSnapshot: metadata({
        ...xaiPlugin,
        modelCatalog: {
          suppressions: [nativeSuppression("Retired native selector", "grok-4.6")],
        },
      }),
    });
  }

  it("keeps a retired primary local to the automatic plan", async () => {
    const owner = retiredXaiOwner();
    const raw = "xai/auto";
    const ref = { provider: "xai", model: "auto" };
    const request = { raw, source: "automatic" as const };
    await expectChoice(
      owner.config,
      { ...request, fallbacks: ["fixture/custom-unlisted"] },
      {
        kind: "automatic",
        ref,
      },
    );
    await expectChoice(
      owner.config,
      { ...request, fallbacks: ["xai/auto"] },
      {
        kind: "unavailable",
      },
    );
  });

  it("admits a visible spawn past a retired runtime-preferred fallback", async () => {
    await withTestDir({ prefix: "openclaw-retired-spawn-fallback-" }, async (dir) => {
      const registry = providerRegistry("xai", {
        preferRuntimeResolvedModel: ({ modelId }) => modelId === "auto",
        resolveDynamicModel: ({ modelId }) =>
          modelId === "auto" ? buildModel("xai", modelId, xaiUrl) : undefined,
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
      const { callGateway, tool } = spawnFixture(config);
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
    expect(await chooseModel(owner.config, { raw: "xai/auto" })).toMatchObject({
      kind: "resolved",
    });
    expect(renderPublishedAliases(owner).includes("- Grok: xai/auto")).toBe(true);
  });

  it("uses provider transport normalization for explicit, automatic and published aliases without discovery", async () => {
    const descriptor = buildModel("xai", "grok-4.6", xaiUrl);
    const config: OpenClawConfig = {
      agents: { defaults: { models: { "xai/grok-4.6": { alias: "Grok" } } } },
      models: {
        providers: { xai: { api: "openai-completions", baseUrl: descriptor.baseUrl, models: [] } },
      },
    };
    const prepareDynamicModel = vi.fn(async () => undefined);
    const registry = providerRegistry(
      "xai",
      {
        prepareDynamicModel,
        normalizeTransport: () => ({ api: "openai-responses", baseUrl: descriptor.baseUrl }),
      },
      "xAI",
    );
    const owner = publish(() => true, config, {
      pluginRegistry: registry,
      configuredRuntimeModels: [{ provider: "xai", modelId: descriptor.id, model: descriptor }],
      metadataSnapshot: metadata(xaiPlugin),
    });
    const choice = { ...selection, cfg: config, raw: "xai/grok-4.6" };
    expect(await prepareModelChoice({ ...choice, source: "automatic" })).toMatchObject({
      kind: "resolved",
      model: { api: "openai-responses", baseUrl: descriptor.baseUrl },
    });
    expect(renderPublishedAliases(owner)).toContain("- Grok: xai/grok-4.6");
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    expect(await prepareModelChoice(choice)).toMatchObject({
      kind: "resolved",
      model: { api: "openai-responses", baseUrl: descriptor.baseUrl },
    });
  });

  it("does not certify a Platform-only model on a pinned subscription route", async () => {
    const config = providerConfig("openai", {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [],
    });
    const row = {
      provider: "openai",
      id: "chat-latest",
      name: "Platform chat",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const owner = publish(() => true, config, {
      modelCatalog: modelCatalog(row),
    });
    bindProfiles(owner, {
      oauth: {
        provider: "openai",
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 9_999_999_999_999,
      },
    });
    await expectChoice(
      config,
      { raw: "openai/chat-latest@oauth" },
      unavailable("only through OpenAI Platform"),
    );
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
    {
      isCurrent = () => true,
      row = nativeRow,
    }: {
      isCurrent?: () => boolean;
      row?: Parameters<typeof modelCatalog>[0];
    } = {},
  ) {
    const state = {
      registered: true,
      renewalRegisters: true,
      renewed: modelCatalog(row),
    };
    const reload = vi.fn(async () => {
      state.registered = state.renewalRegisters;
      return state.renewed;
    });
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "native-test",
      source: "fixture",
      harness: {
        id: "native-test",
        label: "Native test",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: () =>
          state.registered ? { accountType: "subscription", authMode: "oauth" } : undefined,
        async runAttempt() {
          throw new Error("Admission must not execute inference");
        },
      },
    });
    const owner = publish(isCurrent, config, {
      pluginRegistry: registry,
      loadNativeModelCatalog: reload,
      modelCatalog: state.renewed,
      configuredRuntimeModels: configuredModel("fixture", "native", "https://native.invalid/v1"),
    });
    bindProfiles(owner, {});
    return { state, reload };
  }
  // The runtime comes from the catalog row, so only the renewed catalog decides admission.
  const implicitNative = runtimeConfig("fixture/native");

  it.each(["anthropic", "claude-cli"])(
    "rechecks recovered native auth before admitting %s without a catalog refresh",
    async (provider) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            pluginId: "anthropic",
            config: { command: "claude" },
          },
        ],
      });
      try {
        const raw = `${provider}/claude-opus-5-5`;
        const config = runtimeConfig(raw, "claude-cli");
        const row = { provider, id: "claude-opus-5-5", name: "Claude" };
        const owner = publish(() => true, config, {
          modelCatalog: modelCatalog(row),
          configuredRuntimeModels: configuredModel(
            provider,
            row.id,
            "https://api.anthropic.com",
            "anthropic-messages",
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
        const result = await chooseModel(config, { raw });
        expect(result).toMatchObject({
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
      const config: OpenClawConfig = configured
        ? runtimeConfig("fixture/native", "native-test")
        : implicitNative;
      // Configured ownership must renew without a row-owned runtime.
      const { nativeRuntime: _, ...configuredRow } = nativeRow;
      const { state, reload } = publishNativeRenewal(config, {
        row: configured ? configuredRow : nativeRow,
      });
      const choose = (raw = "fixture/native") => chooseModel(config, { source, raw });
      expect(await choose()).toMatchObject(nativeResolved);
      expect(reload).not.toHaveBeenCalled();
      state.registered = false;
      expect(await choose()).toMatchObject(nativeResolved);
      expect(reload).toHaveBeenCalledExactlyOnceWith(nativeRenewal);
      state.registered = false;
      state.renewalRegisters = false;
      expect(await choose()).toMatchObject(
        configured ? unavailable() : unavailable("Restore that account"),
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
      state.renewed = modelCatalog(moved);
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
      await expectChoice(
        implicitNative,
        { source, raw: "fixture/native" },
        { kind: "unavailable" },
      );
      expect(reload).toHaveBeenCalledExactlyOnceWith(nativeRenewal);
    },
  );
});
