import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    doctorLegacyState: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "matrixSetupPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setMatrixRuntime",
  },
  doctorLegacyState: {
    specifier: "./doctor-legacy-state-api.js",
    exportName: "detectMatrixLegacyStateMigrations",
  },
});
