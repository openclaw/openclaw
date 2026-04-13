import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-contract";
import { AgentP2PConfigSchema, type AgentP2PConfig } from "./config-schema.js";
import { createAgentP2PClient, type AgentP2PClient } from "./client.js";
import type { AgentP2PMessage } from "./types.js";
import { getRuntimeLogger } from "../runtime-api.js";

// Store active clients
const clients = new Map<string, AgentP2PClient>();

// Store account configs for listAccounts
const accountConfigs = new Map<string, AgentP2PConfig>();

export const agentP2PPlugin: ChannelPlugin<AgentP2PConfig> = createChatChannelPlugin({
  id: "agent-p2p",
  name: "Agent P2P",
  description: "Connect to Agent P2P Portal for P2P messaging",
  
  // Configuration
  configSchema: AgentP2PConfigSchema,
  
  // Account management
  async listAccounts() {
    // Return configured accounts
    return Array.from(accountConfigs.entries()).map(([id, config]) => ({
      id,
      name: config.agentName || id,
      status: clients.has(id) && clients.get(id)?.isConnected() ? "connected" : "disconnected",
    }));
  },
  
  async resolveAccount(accountId: string) {
    const config = accountConfigs.get(accountId);
    if (!config) return null;
    
    return {
      id: accountId,
      name: config.agentName || accountId,
      status: clients.has(accountId) && clients.get(accountId)?.isConnected() ? "connected" : "disconnected",
    };
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
    const logger = getRuntimeLogger();
    const account = ctx.account;
    if (!account) {
      throw new Error("No account configured");
    }
    
    const config = account.config as AgentP2PConfig;
    
    try {
      // Send via Portal HTTP API
      const response = await fetch(`${config.portalUrl}/api/message/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": config.apiKey,
        },
        body: JSON.stringify({
          to: target,
          content: content,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      logger.log(`[Agent P2P] Message sent to ${target}`);
    } catch (err) {
      logger.error("[Agent P2P] Failed to send message:", err);
      throw err;
    }
  },
  
  // Lifecycle
  async startMonitoring(ctx) {
    const logger = getRuntimeLogger();
    const account = ctx.account;
    if (!account) {
      throw new Error("No account configured");
    }
    
    const config = account.config as AgentP2PConfig;
    
    // Store config for listAccounts
    accountConfigs.set(account.id, config);
    
    const client = createAgentP2PClient({
      config,
      onConnect: () => {
        logger.log(`[Agent P2P] Account ${account.id} connected`);
      },
      onDisconnect: () => {
        logger.log(`[Agent P2P] Account ${account.id} disconnected`);
      },
      onMessage: (message: AgentP2PMessage) => {
        // Handle incoming message
        ctx.onMessage?.(message);
      },
      onError: (err) => {
        logger.error(`[Agent P2P] Account ${account.id} error:`, err);
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
    accountConfigs.delete(account.id);
  },
});
