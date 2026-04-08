import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "matrixPlugin",
  },
  secrets: {
    specifier: "./src/secret-contract.js",
    exportName: "channelSecrets",
  },
});
