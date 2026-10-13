import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { registerDiscordSubagentHooks } from "./subagent-hooks-api.js";

export default defineBundledChannelEntry({
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "discordPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setDiscordRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectDiscordReadOnlyAccount",
  },
  registerFull(api) {
    // Account inspection loads this entry too; runtime registration must stay behind its owner mode.
    loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
      specifier: "./activities-api.js",
      exportName: "registerDiscordActivities",
    })(api);
    registerDiscordSubagentHooks(api);
  },
  registerCapabilities(api) {
    loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
      specifier: "./transcripts-source-api.js",
      exportName: "registerDiscordTranscriptSourceProvider",
    })(api);
  },
});
