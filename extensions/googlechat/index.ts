import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "googlechat",
  name: "Google Chat",
  description: "OpenClaw Google Chat channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "googlechatPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setGoogleChatRuntime",
  },
});
