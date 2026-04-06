import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "irc",
  name: "IRC",
  description: "IRC channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "ircPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setIrcRuntime",
  },
});
