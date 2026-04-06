import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "email",
  name: "Email",
  description: "Email channel plugin — IMAP polling inbound, SMTP outbound",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "emailPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setEmailRuntime",
  },
});
