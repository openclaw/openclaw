import { definePluginEntry } from "@openclaw/plugin-sdk/plugin-entry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default definePluginEntry({
  id: "xai",
  name: "xAI Setup",
  description: "Lightweight xAI setup hooks",
  register(api) {
    api.registerAutoEnableProbe(({ config }) => {
      const pluginConfig = config.plugins?.entries?.xai?.config;
      const web = config.tools?.web as Record<string, unknown> | undefined;
      if (
        isRecord(web?.x_search) ||
        (isRecord(pluginConfig) &&
          (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution)))
      ) {
        return "xai tool configured";
      }
      return null;
    });
  },
});
