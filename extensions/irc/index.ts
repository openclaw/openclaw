import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "irc",
  name: "IRC",
  description: "IRC channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "ircPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setIrcRuntime",
  },
});
