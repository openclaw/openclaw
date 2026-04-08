import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "msteamsPlugin",
  },
  secrets: {
    specifier: "./src/secret-contract.js",
    exportName: "channelSecrets",
  },
});
