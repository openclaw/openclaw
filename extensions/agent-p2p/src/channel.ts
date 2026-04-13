import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-contract";
import { AgentP2PConfigSchema, type AgentP2PConfig } from "./config-schema.js";
import { createAgentP2PClient, type AgentP2PClient } from "./client.js";
import type { AgentP2PMessage } from "./types.js";

// Store active clients
const clients = new Map<string, AgentP2PClient>();

export const agentP2PPlugin: ChannelPlugin<AgentP2PConfig> = createChatChannelPlugin({
  id: "agent-p2p",
  name: "Agent P2P",
  description: "Connect to Agent P2P Portal for P2P messaging",
  
  // Configuration
  configSchema: AgentP2PConfigSchema,
  
  // Account management
  async listAccounts() {
    // Return configured accounts from config
    return [];
  },
  
  async resolveAccount(accountId: string) {
    // Resolve account by ID
    return null;
  },
  
  // Message handling
  async onMessage(ctx, message) {
    // Handle incoming message from Portal
    console.log("[Agent P2P] Received message:", message);
    
    // Dispatch to OpenClaw session
    ctx.dispatch({
      type: "message",
      content: message.content,
      sender: message.from,
      timestamp: message.timestamp,
    });
  },
  
  // Send message
  async sendMessage(ctx, target, content) {
    // Send message via Portal API
    const account = ctx.account;
    if (!account) {
      throw new Error("No account configured");
    }
    
    // TODO: Implement HTTP POST to Portal /api/message/send
    console.log("[Agent P2P] Sending message:", { target, content });
  },
  
  // Lifecycle
  async startMonitoring(ctx) {
    const account = ctx.account;
    if (!account) {
      throw new Error("No account configured");
    }
    
    const config = account.config as AgentP2PConfig;
    
    const client = createAgentP2PClient({
      config,
      onConnect: () => {
        console.log(`[Agent P2P] Account ${account.id} connected`);
      },
      onDisconnect: () => {
        console.log(`[Agent P2P] Account ${account.id} disconnected`);
      },
      onMessage: (message: AgentP2PMessage) => {
        // Handle incoming message
        ctx.onMessage?.(message);
      },
      onError: (err) => {
        console.error(`[Agent P2P] Account ${account.id} error:`, err);
      },
    });
    
    await client.connect();
    clients.set(account.id, client);
  },
  
  async stopMonitoring(ctx) {
    const account = ctx.account;
    if (!account) return;
    
    const client = clients.get(account.id);
    if (client) {
      client.disconnect();
      clients.delete(account.id);
    }
  },
});
