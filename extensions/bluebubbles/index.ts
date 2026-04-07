import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "bluebubbles",
  name: "BlueBubbles",
  description: "BlueBubbles channel plugin (macOS app)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "bluebubblesPlugin",
  },
  secrets: {
    specifier: "./src/secret-contract.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setBlueBubblesRuntime",
  },
});
