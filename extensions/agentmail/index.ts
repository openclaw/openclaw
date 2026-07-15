import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "agentmail",
  name: "AgentMail",
  description: "Official AgentMail channel plugin for durable, reply-only email conversations.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "agentMailPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setAgentMailRuntime",
  },
});
