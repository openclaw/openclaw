import fs from "node:fs";
import type { AgentCompactionConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";

/** Shared real provider package; each suite adds its own lifecycle behavior. */
export function createCompactionResourceProvider(options: {
  pluginRoot: string;
  providerId: string;
  workspaceDir: string;
  contextWindow: number;
  modelEndpoint?: boolean;
  compaction: AgentCompactionConfig;
}) {
  const { pluginRoot, providerId, workspaceDir, compaction } = options;
  fs.mkdirSync(pluginRoot, { recursive: true });
  const plugin = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: providerId,
    providerId,
    manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [] },
  });
  const model = makeProviderModelFixture<"openai-completions">({
    id: "model",
    provider: providerId,
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    contextWindow: options.contextWindow,
    maxTokens: 1024,
  });
  const { provider: _provider, api, baseUrl, ...configuredModel } = model;
  const defaults = {
    workspace: workspaceDir,
    model: { primary: `${providerId}/model` },
    compaction,
  };
  const config = {
    agents: { defaults },
    models: {
      providers: {
        [providerId]: {
          api: model.api,
          apiKey: "fixture-key",
          baseUrl: model.baseUrl,
          models: [{ ...configuredModel, ...(options.modelEndpoint ? { api, baseUrl } : {}) }],
        },
      },
    },
    plugins: {
      allow: [providerId],
      load: { paths: [pluginRoot] },
      slots: { memory: "none" },
      entries: { [providerId]: { enabled: true } },
    },
  } satisfies OpenClawConfig;
  fs.writeFileSync(
    plugin.runtimeSource,
    `module.exports = {
  id: ${JSON.stringify(providerId)}, register(api) {
    api.registerProvider({ id: ${JSON.stringify(providerId)}, label: "Fixture", auth: [] });
  }
};`,
  );
  return { plugin, model, config };
}
