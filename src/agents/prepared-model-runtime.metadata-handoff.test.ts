// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import * as manifestEligibility from "../plugins/manifest-contract-eligibility.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();
const { mocks } = fixture;

describe("prepared model runtime metadata handoff", () => {
  it("adds an agent using captured model policies without rediscovering plugin inventory", async () => {
    const metadata = (model: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            modelIdNormalization: { providers: { fixture: { aliases: { raw: model } } } },
          },
        ],
      });
    const captured = metadata("canonical");
    const discovery = vi
      .spyOn(manifestEligibility, "loadManifestMetadataSnapshot")
      .mockReturnValue(captured);
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const config: OpenClawConfig = {
      agents: { defaults: { model: "fixture/raw" }, entries: { pro: {} } },
    };
    mocks.configuredAgentIds = ["pro"];
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      provider,
      api: "openai-responses",
      baseUrl: "https://synthetic.invalid/v1",
    }));
    try {
      setActivePluginRegistry(
        createEmptyPluginRegistry(),
        undefined,
        "default",
        fixture.state.workspaceDir,
      );
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: captured,
      });
      const original = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config))!;
      discovery.mockClear().mockReturnValue(metadata("ambient"));
      mocks.configuredAgentIds = ["pro", "new-agent"];
      const nextConfig: OpenClawConfig = {
        agents: { ...config.agents, entries: { pro: {}, "new-agent": {} } },
      };

      await refreshModelRuntimeAfterHotReload({
        config: nextConfig,
        agentIds: new Set(["new-agent"]),
        pluginMetadataSnapshot: captured,
      });

      const added = getPreparedModelRuntimeSnapshot(fixture.agentInput("new-agent", nextConfig))!;
      const retained = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", nextConfig))!;
      expect.soft(discovery.mock.calls.length).toBe(0);
      expect.soft(original.isCurrent()).toBe(true);
      expect.soft(retained.modelCatalog).toBe(original.modelCatalog);
      expect(added.metadataSnapshot).toBe(captured);
      expect(added.isCurrent()).toBe(true);
      const models = added.configuredRuntimeModels.map(({ modelId }) => modelId);
      expect(models).toEqual(["raw"]);
    } finally {
      discovery.mockRestore();
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  });
});
