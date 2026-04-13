import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { getRuntimeLogger } from "../runtime-api.js";
import { createAgentP2PClient, type AgentP2PClient } from "./client.js";
import type { AgentP2PConfig } from "./types.js";
import type { AgentP2PMessage } from "./types.js";

// Store active clients
const clients = new Map<string, AgentP2PClient>();

// Store account configs for listAccounts
const accountConfigs = new Map<string, AgentP2PConfig>();

// Base implementation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base: any = {
  id: "agent-p2p",
  meta: {
    id: "agent-p2p",
    label: "Agent P2P",
    selectionLabel: "Agent P2P (P2P messaging)",
    docsPath: "/channels/agent-p2p",
    docsLabel: "agent-p2p",
    blurb: "Connect to Agent P2P Portal for decentralized messaging.",
    aliases: ["p2p"],
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },
  config: {},

  async listAccounts() {
    return Array.from(accountConfigs.entries()).map(([id, config]) => ({
      id,
      name: config.agentName || id,
      status: clients.has(id) && clients.get(id)?.isConnected() ? "connected" : "disconnected",
    }));
  },

  async resolveAccount(accountId: string) {
    const config = accountConfigs.get(accountId);
    if (!config) {
      return null;
    }

    return {
      id: accountId,
      name: config.agentName || accountId,
      status:
        clients.has(accountId) && clients.get(accountId)?.isConnected()
          ? "connected"
          : "disconnected",
    };
  },

  async onMessage(ctx: unknown, message: AgentP2PMessage) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typedCtx = ctx as any;
    const logger = getRuntimeLogger();
    logger.log("[Agent P2P] Received message:", message);

    typedCtx.dispatch({
      type: "message",
      content: message.content,
      sender: message.from,
      timestamp: message.timestamp,
    });
  },

  async sendMessage(ctx: unknown, target: string, content: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typedCtx = ctx as any;
    const logger = getRuntimeLogger();
    const account = typedCtx.account;
    if (!account) {
      throw new Error("No account configured");
    }

    const config = account.config as AgentP2PConfig;

    try {
      const { response, release } = await fetchWithSsrFGuard({
        url: `${config.portalUrl}/api/message/send`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": config.apiKey,
          },
          body: JSON.stringify({
            to: target,
            content: content,
          }),
        },
      });

      try {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
      } finally {
        void release();
      }

      logger.log(`[Agent P2P] Message sent to ${target}`);
    } catch (err) {
      logger.error("[Agent P2P] Failed to send message:", err);
      throw err;
    }
  },

  async startMonitoring(ctx: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typedCtx = ctx as any;
    const logger = getRuntimeLogger();
    const account = typedCtx.account;
    if (!account) {
      throw new Error("No account configured");
    }

    const config = account.config as AgentP2PConfig;
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
        typedCtx.onMessage?.(message);
      },
      onError: (err: Error) => {
        logger.error(`[Agent P2P] Account ${account.id} error:`, err);
      },
    });

    await client.connect();
    clients.set(account.id, client);
  },

  async stopMonitoring(ctx: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typedCtx = ctx as any;
    const account = typedCtx.account;
    if (!account) {
      return;
    }

    const client = clients.get(account.id);
    if (client) {
      client.disconnect();
      clients.delete(account.id);
    }
    accountConfigs.delete(account.id);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const agentP2PPlugin: any = createChatChannelPlugin({
  base,
});
