import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

function registerMSTeamsFullPlugin(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./runtime-api.js",
    exportName: "registerMSTeamsFullPlugin",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "msteamsPlugin",
  },
  secrets: {
    specifier: "./src/secret-contract.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMSTeamsRuntime",
  },
  registerFull(api) {
    registerMSTeamsFullPlugin(api);
  },
});
