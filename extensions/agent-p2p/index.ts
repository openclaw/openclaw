import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "agent-p2p",
  name: "Agent P2P",
  description: "Connect to Agent P2P Portal for P2P messaging",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "agentP2PPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setAgentP2PRuntime",
  },
});
