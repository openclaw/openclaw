/**
 * OpenClaw A2A Gateway Plugin
 *
 * Implements the Google A2A v0.3.0 protocol, enabling cross-network
 * agent-to-agent communication. Mounts onto the existing Gateway HTTP
 * server — no separate port needed.
 *
 * Endpoints:
 *   GET  /.well-known/agent-card.json  → Agent Card (discovery)
 *   POST /a2a/jsonrpc                  → A2A JSON-RPC (message/send, tasks/get)
 *
 * Agent tools:
 *   a2a_discover  → fetch a remote agent's capabilities
 *   a2a_send      → send a message to a remote A2A agent
 *
 * Gateway methods:
 *   a2a.card        → get local Agent Card
 *   a2a.peers.list  → list configured peers
 *
 * CLI commands:
 *   openclaw a2a status    → plugin status summary
 *   openclaw a2a card      → print Agent Card JSON
 *   openclaw a2a peers     → list configured peers
 *   openclaw a2a discover  → fetch remote Agent Card
 *   openclaw a2a send      → send message to remote peer
 *   openclaw a2a check     → check peer health
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AGENT_CARD_PATHS } from "./src/agent-card.js";
import { registerA2ACli } from "./src/cli.js";
import { checkPeerHealth, fetchAgentCard, sendMessageToPeer } from "./src/client.js";
import { parseA2AConfig, a2aConfigSchema } from "./src/config.js";
import { createA2AServer } from "./src/server.js";
import { createA2ADiscoverTool, createA2ASendTool } from "./src/tools/a2a-tools.js";

const a2aPlugin = {
  id: "a2a",
  name: "A2A Gateway",
  description: "Google A2A v0.3.0 protocol gateway — cross-network agent-to-agent communication",
  configSchema: a2aConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = parseA2AConfig(api.pluginConfig);

    if (!cfg.enabled) {
      api.logger.info(
        "[a2a] plugin disabled (set plugins.entries.a2a.config.enabled = true to activate)",
      );
      return;
    }

    // Warn if bearer mode but no token
    if (cfg.auth.mode === "bearer" && !cfg.auth.token) {
      api.logger.warn(
        "[a2a] bearer auth enabled but no token configured — inbound requests will be accepted without auth. " +
          "Set plugins.entries.a2a.config.auth.token to secure the endpoint.",
      );
    }

    // Resolve state directory for task persistence
    const stateDir = api.resolvePath("~/.openclaw/state/a2a");

    // Read gateway auth token from config (for local agent dispatch)
    const gatewayCfg = api.config as Record<string, unknown>;
    const gatewayAuth = (gatewayCfg.gateway as Record<string, unknown> | undefined)?.auth as
      | Record<string, unknown>
      | undefined;
    const gatewayAuthToken = typeof gatewayAuth?.token === "string" ? gatewayAuth.token : undefined;

    // Create A2A server
    const server = createA2AServer(cfg, stateDir, api.logger, gatewayAuthToken);

    // ① Mount A2A endpoints on Gateway HTTP (no extra port)
    // Agent Card discovery — public, no auth
    for (const cardPath of AGENT_CARD_PATHS) {
      api.registerHttpRoute({
        path: cardPath,
        handler: server.handleRequest,
        auth: "plugin",
        match: "exact",
      });
    }
    // JSON-RPC endpoint — auth managed by the plugin (bearer token check)
    api.registerHttpRoute({
      path: "/a2a/jsonrpc",
      handler: server.handleRequest,
      auth: "plugin",
      match: "exact",
    });

    // ② Register agent tools
    api.registerTool(createA2ADiscoverTool(cfg), { name: "a2a_discover" });
    api.registerTool(createA2ASendTool(cfg, api), { name: "a2a_send" });

    // ③ Gateway methods for CLI / Web UI
    api.registerGatewayMethod("a2a.card", async ({ respond }) => {
      respond(true, { agentCard: server.agentCard });
    });

    api.registerGatewayMethod("a2a.peers.list", async ({ respond }) => {
      const peers = cfg.peers.map((p) => ({
        name: p.name,
        agentCardUrl: p.agentCardUrl,
        hasAuth: !!p.auth,
      }));
      respond(true, { peers });
    });

    api.registerGatewayMethod("a2a.peers.discover", async ({ params, respond }) => {
      try {
        const name = typeof params?.name === "string" ? params.name.trim() : "";
        const url = typeof params?.url === "string" ? params.url.trim() : "";
        const peer = cfg.peers.find((p) => p.name.toLowerCase() === name.toLowerCase());

        const cardUrl = peer?.agentCardUrl ?? url;
        if (!cardUrl) {
          respond(false, { error: "name or url required" });
          return;
        }

        const card = await fetchAgentCard(cardUrl, peer?.auth);
        respond(true, { agentCard: card });
      } catch (err) {
        respond(false, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    api.registerGatewayMethod("a2a.peers.send", async ({ params, respond }) => {
      try {
        const name = typeof params?.name === "string" ? params.name.trim() : "";
        const message = typeof params?.message === "string" ? params.message.trim() : "";
        const agentId = typeof params?.agentId === "string" ? params.agentId.trim() : undefined;

        if (!name || !message) {
          respond(false, { error: "name and message required" });
          return;
        }

        const peer = cfg.peers.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (!peer) {
          respond(false, { error: `peer "${name}" not found in config` });
          return;
        }

        const result = await sendMessageToPeer({
          peer,
          message,
          agentId,
          blocking: true,
          timeoutMs: cfg.timeouts.agentResponseMs,
        });
        respond(true, result);
      } catch (err) {
        respond(false, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    api.registerGatewayMethod("a2a.peers.check", async ({ params, respond }) => {
      try {
        const name = typeof params?.name === "string" ? params.name.trim() : "";
        const targets = name
          ? cfg.peers.filter((p) => p.name.toLowerCase() === name.toLowerCase())
          : cfg.peers;

        if (targets.length === 0) {
          respond(false, { error: name ? `peer "${name}" not found` : "no peers configured" });
          return;
        }

        const results = await Promise.all(targets.map((p) => checkPeerHealth(p)));
        respond(true, { results });
      } catch (err) {
        respond(false, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // ④ Background service — task cleanup
    api.registerService({
      id: "a2a",
      start: async () => {
        server.start();
      },
      stop: async () => {
        server.stop();
      },
    });

    // ⑤ CLI subcommands — `openclaw a2a <subcommand>`
    api.registerCli(({ program }) => registerA2ACli({ program, config: cfg, logger: api.logger }), {
      commands: ["a2a"],
    });

    api.logger.info(
      `[a2a] plugin registered — card: "${cfg.card.name}", peers: ${cfg.peers.length}`,
    );
  },
};

export default a2aPlugin;
