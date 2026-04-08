import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "eclaw",
  name: "E-Claw",
  description: "OpenClaw E-Claw channel plugin (Android live wallpaper character integration)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "eclawPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setEclawRuntime",
  },
});
