import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "zalo",
  name: "Zalo",
  description: "Zalo channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "zaloPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setZaloRuntime",
  },
});
