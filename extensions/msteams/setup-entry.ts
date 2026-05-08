import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    legacyStateMigrations: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "msteamsSetupPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  legacyStateMigrations: {
    specifier: "./legacy-state-migrations-api.js",
    exportName: "detectMSTeamsLegacyStateMigrations",
  },
});
