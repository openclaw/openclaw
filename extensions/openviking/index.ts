import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  OpenVikingContextEngine,
  type OpenVikingPluginConfig,
} from "./src/openviking-context-engine.js";
import { openVikingPluginConfigSchema, openVikingPluginManifest } from "./src/plugin-manifest.js";

export default definePluginEntry({
  id: openVikingPluginManifest.id,
  name: openVikingPluginManifest.name,
  description: openVikingPluginManifest.description,
  kind: openVikingPluginManifest.kind,
  configSchema: openVikingPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    api.registerContextEngine(openVikingPluginManifest.id, () => {
      const pluginConfig = (api.pluginConfig ?? {}) as OpenVikingPluginConfig;
      api.logger.info?.("openviking: context engine registered");
      return new OpenVikingContextEngine(pluginConfig, api.logger);
    });
  },
});
