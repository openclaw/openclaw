import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "max-messenger",
  name: "MAX Messenger",
  description: "MAX (Russian messenger by VK) channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel-plugin.js",
    exportName: "maxMessengerPlugin",
  },
  secrets: {
    specifier: "./src/secret-contract.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setMaxRuntime",
  },
});
