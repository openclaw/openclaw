// Rcs plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "rcs",
  name: "RCS",
  description: "Twilio RCS Business Messaging channel plugin for OpenClaw.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "rcsPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setRcsRuntime",
  },
});
