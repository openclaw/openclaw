/**
 * Agent tools for A2A communication.
 *
 * Provides two tools that OpenClaw agents can use:
 *   - a2a_discover: fetch a remote agent's Agent Card
 *   - a2a_send: send a message to a remote A2A agent
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { fetchAgentCard, sendMessageToPeer } from "../client.js";
import type { A2APluginConfig, A2APeer } from "../config.js";

// ── Helpers ────────────────────────────────────────────────────────

const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

/**
 * Resolve a peer name to its config entry.
 * Accepts either a configured peer name (case-insensitive) or a raw URL.
 */
function resolvePeer(cfg: A2APluginConfig, nameOrUrl: string): A2APeer {
  // Try matching configured peer name
  const match = cfg.peers.find((p) => p.name.toLowerCase() === nameOrUrl.toLowerCase());
  if (match) return match;

  // Treat as raw URL — auto-append agent-card.json if needed
  let url = nameOrUrl.trim();
  if (url && !url.includes("agent-card.json") && !url.includes("agent.json")) {
    url = url.replace(/\/+$/, "") + "/.well-known/agent-card.json";
  }

  return { name: nameOrUrl, agentCardUrl: url };
}

// ── a2a_discover ───────────────────────────────────────────────────

export function createA2ADiscoverTool(cfg: A2APluginConfig) {
  return {
    name: "a2a_discover",
    label: "A2A Discover",
    description: [
      "Discover a remote A2A agent by fetching its Agent Card.",
      "Returns the agent's name, description, skills, and capabilities.",
      cfg.peers.length > 0
        ? `Configured peers: ${cfg.peers.map((p) => p.name).join(", ")}.`
        : "No peers configured — provide a URL.",
    ].join(" "),
    parameters: Type.Object({
      peer: Type.String({
        description:
          "Peer name (from config) or base URL of the remote agent " +
          "(e.g. 'http://100.10.10.2:18789')",
      }),
    }),
    async execute(_toolCallId: string, params: { peer: string }) {
      try {
        const peer = resolvePeer(cfg, params.peer);
        const card = await fetchAgentCard(peer.agentCardUrl, peer.auth);
        return jsonResult({
          status: "ok",
          peer: peer.name,
          agentCard: {
            name: card.name,
            description: card.description,
            version: card.version,
            protocolVersion: card.protocolVersion,
            skills: card.skills,
            defaultInputModes: card.defaultInputModes,
            defaultOutputModes: card.defaultOutputModes,
          },
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

// ── a2a_send ───────────────────────────────────────────────────────

export function createA2ASendTool(cfg: A2APluginConfig, _api: OpenClawPluginApi) {
  return {
    name: "a2a_send",
    label: "A2A Send",
    description: [
      "Send a message to a remote A2A agent and get the response.",
      "Use a2a_discover first to check available peers and their skills.",
      cfg.peers.length > 0
        ? `Configured peers: ${cfg.peers.map((p) => p.name).join(", ")}.`
        : "No peers configured — provide a URL.",
    ].join(" "),
    parameters: Type.Object({
      peer: Type.String({
        description: "Peer name (from config) or base URL of the remote agent",
      }),
      message: Type.String({
        description: "The message to send to the remote agent",
      }),
      agentId: Type.Optional(
        Type.String({
          description: "Target a specific agent ID on the remote server (optional)",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { peer: string; message: string; agentId?: string },
    ) {
      try {
        const peer = resolvePeer(cfg, params.peer);
        const result = await sendMessageToPeer({
          peer,
          message: params.message,
          agentId: params.agentId,
          blocking: true,
          timeoutMs: cfg.timeouts.agentResponseMs,
        });
        return jsonResult({
          peer: peer.name,
          ...result,
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          peer: params.peer,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
