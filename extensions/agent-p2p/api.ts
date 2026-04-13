export { agentP2PPlugin } from "./src/channel.js";
export { createAgentP2PClient } from "./src/client.js";
export * from "./src/config-schema.js";
export * from "./src/types.js";

export const agentP2PSessionBindingAdapterChannels = ["agent-p2p"] as const;
