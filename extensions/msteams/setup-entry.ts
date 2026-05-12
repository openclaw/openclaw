import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    doctorLegacyState: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "msteamsSetupPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  doctorLegacyState: {
    specifier: "./doctor-legacy-state-api.js",
    exportName: "detectMSTeamsLegacyStateMigrations",
  },
});
