import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "bluesky",
  name: "Bluesky",
  description: "Bluesky DM channel plugin for OpenClaw",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "blueskyPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setBlueskyRuntime",
  },
});
