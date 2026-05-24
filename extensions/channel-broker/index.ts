import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

function registerChannelBrokerFull(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./http-routes-api.js",
    exportName: "registerChannelBrokerHttpRoutes",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "channel-broker",
  name: "Channel Broker",
  description: "Provider-owned universal messaging channel broker",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "channelBrokerPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setChannelBrokerRuntime",
  },
  registerFull: registerChannelBrokerFull,
});
