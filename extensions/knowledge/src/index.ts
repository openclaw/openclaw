import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { getToolPluginMetadata, toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { PluginConfig, STORES_CONFIG_PATH } from "./stores-config.js";

const feature = defineFeaturePlugin({
  contract,
  name: "Knowledge",
  description: "Evidence-backed knowledge, inspectable in OpenClaw.",
  setup: createKnowledgeService,
});
// This host's feature helper has no config option. Compose its shared adapters
// with the public entry/config and build-metadata SDK, without duplicating them.
const configSchema = PluginConfig;
// Membership edits must not reload the plugin: a hot plugin reload admits no
// new model runs Gateway-wide while it drains. Knowledge applies membership
// in-process; the host still publishes the new runtime config for no-op plans.
const reload = { noopPrefixes: [STORES_CONFIG_PATH.join(".")] };
const entry = definePluginEntry({
  ...feature,
  reload,
  configSchema: buildJsonPluginConfigSchema({ ...configSchema }),
});
Object.defineProperty(entry, toolPluginMetadataSymbol, {
  value: { ...getToolPluginMetadata(feature), configSchema },
  enumerable: false,
});
export default entry;
