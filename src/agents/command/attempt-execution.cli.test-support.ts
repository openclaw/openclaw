import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

/** Model capability and channel discovery fixtures for CLI fallback tests. */
export function createCliImageCapabilityPlugins(model: string) {
  // MCP still builds message schemas before applying the read-only grant.
  // Keep this capability test independent of bundled Discord action discovery.
  const pluginRegistry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: { describeMessageTool: () => null },
      } satisfies ChannelPlugin,
    },
  ]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "anthropic",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
        modelCatalog: {
          providers: {
            anthropic: {
              models: [{ id: model, name: model, reasoning: true, input: ["text", "image"] }],
            },
          },
        },
      },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}
