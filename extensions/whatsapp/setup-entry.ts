import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    doctorLegacyState: true,
    doctorSessionMigrationSurface: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "whatsappSetupPlugin",
  },
  doctorLegacyState: {
    specifier: "./doctor-legacy-state-api.js",
    exportName: "detectWhatsAppLegacyStateMigrations",
  },
  doctorSessionMigrationSurface: {
    specifier: "./doctor-session-migration-surface-api.js",
    exportName: "whatsappDoctorSessionMigrationSurface",
  },
});
