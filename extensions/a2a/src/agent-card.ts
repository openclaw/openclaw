/**
 * Build an A2A v0.3.0 Agent Card from OpenClaw plugin config.
 *
 * The card is served at /.well-known/agent-card.json (v0.3.0 standard path).
 */

import type { AgentCard, SecurityScheme } from "@a2a-js/sdk";
import type { A2APluginConfig } from "./config.js";

export const A2A_PROTOCOL_VERSION = "0.3.0";

/** Well-known paths for Agent Card discovery (v0.3.0 + legacy alias). */
export const AGENT_CARD_PATHS = [
  "/.well-known/agent-card.json",
  "/.well-known/agent.json", // legacy v0.2.x alias
];

/**
 * Build an Agent Card from plugin config.
 * @param cfg  Parsed A2A plugin config.
 * @param gatewayUrl  The externally reachable gateway base URL
 *                    (e.g. "http://100.10.10.1:18789").
 */
export function buildAgentCard(cfg: A2APluginConfig, gatewayUrl: string): AgentCard {
  const baseUrl = gatewayUrl.replace(/\/+$/, "");
  const jsonRpcUrl = `${baseUrl}/a2a/jsonrpc`;

  return {
    name: cfg.card.name,
    description: cfg.card.description,
    version: cfg.card.version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    url: jsonRpcUrl,
    skills: cfg.card.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags ?? [],
    })),
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: cfg.card.defaultInputModes as ("text" | "file" | "data")[],
    defaultOutputModes: cfg.card.defaultOutputModes as ("text" | "file" | "data")[],
    // Security schemes (OpenAPI 3.0 style) for bearer auth discovery
    ...(cfg.auth.mode === "bearer"
      ? {
          securitySchemes: {
            bearer: { type: "http" as const, scheme: "bearer" } as SecurityScheme,
          },
          security: [{ bearer: [] }],
        }
      : {}),
  } satisfies AgentCard;
}
