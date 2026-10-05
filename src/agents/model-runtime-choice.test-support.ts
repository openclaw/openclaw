import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import type { AgentHarness } from "./harness/types.js";
import { bindPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

export async function createCustomNativeCommandChoiceFixture(
  condition: "unowned" | "owned" | "ambiguous" | "host-auth" | "transport" = "unowned",
  isCurrent = () => true,
) {
  const provider = "autodev";
  const model = "codex-test-model";
  const entry = { provider, id: model, name: "Synthetic Codex model", reasoning: false };
  const cfg: OpenClawConfig = {
    plugins: { entries: { codex: { enabled: true } } },
    agents: {
      defaults: {
        model: `${provider}/${model}`,
        models: {
          [`${provider}/${model}`]: { agentRuntime: { id: "codex" } },
        },
      },
    },
    models: {
      providers: {
        [provider]: {
          auth: "native-command",
          api: "openai-responses",
          baseUrl: "https://devapi.example.test/api/autodev/llm/v1",
          ...(condition === "host-auth" ? { apiKey: "synthetic-host-key" } : {}),
          ...(condition === "transport" ? { headers: { "X-Synthetic": "fixture" } } : {}),
          models: [
            {
              id: model,
              name: entry.name,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
              agentRuntime: { id: "codex" },
            },
          ],
        },
      },
    },
  };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "codex", activation: { onAgentHarnesses: ["codex"] }, syntheticAuthRefs: ["codex"] },
      ...(condition === "owned" || condition === "ambiguous"
        ? [{ id: "custom-owner", providers: [provider] }]
        : []),
      ...(condition === "ambiguous" ? [{ id: "second-owner", providers: [provider] }] : []),
    ],
  });
  const { createCodexHarnessForTest } = await loadBundledPluginFacade<{
    createCodexHarnessForTest: () => Promise<AgentHarness>;
  }>({ pluginId: "codex", artifactBasename: "test-api.js" });
  const harness = await createCodexHarnessForTest();
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.agentHarnesses.push({ pluginId: "codex", source: "fixture", harness });
  const owner = createModelRuntimeChoiceOwnerFixture(cfg, isCurrent, {
    pluginRegistry,
    metadataSnapshot,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
  });
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
  return { cfg, provider, model, entry, harness, pluginRegistry, metadataSnapshot, owner };
}

export function createModelRuntimeChoiceOwnerFixture(
  config: OpenClawConfig,
  isCurrent = () => true,
  facts: Partial<
    Pick<
      PreparedModelRuntimeSnapshot,
      | "authModes"
      | "pluginRegistry"
      | "modelCatalog"
      | "configuredRuntimeModels"
      | "metadataSnapshot"
      | "agentDir"
      | "workspaceDir"
    >
  > = {},
  paths: { agentDir?: string; workspaceDir?: string } = {},
): PreparedModelRuntimeSnapshot {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const configuredRuntimeModels = facts.configuredRuntimeModels ?? [];
  const metadataSnapshot = facts.metadataSnapshot ?? createPluginMetadataSnapshotFixture();
  const workspaceDir = paths.workspaceDir ?? facts.workspaceDir ?? "/tmp/runtime-choice";
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir },
    agentId: "main",
    agentDir: paths.agentDir ?? "/tmp/runtime-choice/agent",
    workspaceDir,
    activeProjectKeys: [],
    authModes: facts.authModes ?? {},
    pluginRegistry: facts.pluginRegistry,
    metadataSnapshot,
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: facts.modelCatalog ?? { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels,
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      metadataSnapshot,
    ),
    inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}, {
      providerMetadataOwners: facts.metadataSnapshot?.owners,
    }),
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
    ...facts,
  };
  bindPreparedModelRuntimeAuth(owner, {
    store: {
      version: 1,
      profiles: {
        "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
      },
    },
  });
  return owner;
}
