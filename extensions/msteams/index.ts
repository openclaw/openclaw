import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "msteamsPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMSTeamsRuntime",
  },
});
