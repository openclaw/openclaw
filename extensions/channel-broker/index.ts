import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "channel-broker",
  name: "Channel Broker",
  description: "Provider-owned universal messaging channel broker",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "channelBrokerPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setChannelBrokerRuntime",
  },
});
