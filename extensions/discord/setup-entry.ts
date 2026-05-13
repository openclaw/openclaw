import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    doctorLegacyState: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "discordSetupPlugin",
  },
  doctorLegacyState: {
    specifier: "./doctor-legacy-state-api.js",
    exportName: "detectDiscordLegacyStateMigrations",
  },
});
