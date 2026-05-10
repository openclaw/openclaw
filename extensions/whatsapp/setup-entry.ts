import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    doctorLegacyState: true,
    legacySessionSurfaces: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "whatsappSetupPlugin",
  },
  doctorLegacyState: {
    specifier: "./doctor-legacy-state-api.js",
    exportName: "detectWhatsAppLegacyStateMigrations",
  },
  legacySessionSurface: {
    specifier: "./legacy-session-surface-api.js",
    exportName: "whatsappLegacySessionSurface",
  },
});
