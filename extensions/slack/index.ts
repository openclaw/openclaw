import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

let slackSubagentHooksPromise: Promise<typeof import("./src/subagent-hooks.js")> | null = null;
function loadSlackSubagentHooksModule(): Promise<typeof import("./src/subagent-hooks.js")> {
  slackSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return slackSubagentHooksPromise;
}

function registerSlackPluginHttpRoutes(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./runtime-api.js",
    exportName: "registerSlackPluginHttpRoutes",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "slackPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setSlackRuntime",
  },
  registerFull(api: OpenClawPluginApi) {
    registerSlackPluginHttpRoutes(api);
    api.on("subagent_delivery_target", async (event) => {
      const { handleSlackSubagentDeliveryTarget } = await loadSlackSubagentHooksModule();
      return handleSlackSubagentDeliveryTarget(event);
    });
  },
});
