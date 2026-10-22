import type { IncomingMessage } from "node:http";
import { listAgentIds, resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  A2A_PROTOCOL_VERSION,
  type A2aAgentCapabilities,
  type A2aAgentCard,
  type A2aAgentExtension,
  type A2aAgentInterface,
  type A2aAgentSkill,
} from "./a2a-model.js";
import type { A2aChannelConfig } from "./types.js";

export const A2A_JSONRPC_BINDING = "JSONRPC";
export const A2A_REST_BINDING = "HTTP+JSON";
export const A2A_JSONRPC_PATH = "/a2a/v1";
export const A2A_REST_PATH = "/a2a/v1/rest";
export const A2A_EXTENDED_CARD_PATH = "/a2a/v1/extendedAgentCard";

/** The IANA-registered discovery path; the 0.3-era `agent.json` stays as an alias. */
export const A2A_AGENT_CARD_PATHS = [
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
] as const;

export type A2aResolvedCapabilities = {
  streaming: boolean;
  pushNotifications: boolean;
  extendedAgentCard: boolean;
};

export type A2aAgentCardParams = {
  config: OpenClawConfig;
  a2aConfig: A2aChannelConfig;
  version: string;
  request: IncomingMessage;
  capabilities: A2aResolvedCapabilities;
  /** Extended cards may publish operator-authored skill descriptions. */
  extended: boolean;
};

function resolveRequestOrigin(request: IncomingMessage): string {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  try {
    return new URL(`${encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`)
      .origin;
  } catch {
    return `${encrypted ? "https" : "http"}://localhost`;
  }
}

function resolveAdvertisedOrigin(params: {
  a2aConfig: A2aChannelConfig;
  request: IncomingMessage;
}): string {
  return (params.a2aConfig.advertisedUrl ?? resolveRequestOrigin(params.request)).replace(
    /\/+$/u,
    "",
  );
}

function resolveExtensions(a2aConfig: A2aChannelConfig): A2aAgentExtension[] | undefined {
  const entries = a2aConfig.extensions ?? [];
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map((entry) => {
    const mapped: A2aAgentExtension = { uri: entry.uri, required: entry.required === true };
    if (entry.description) {
      mapped.description = entry.description;
    }
    if (entry.params) {
      mapped.params = entry.params;
    }
    return mapped;
  });
}

/**
 * Build the Agent Card (spec §4.4.1 / §8.2).
 *
 * The public card is served unauthenticated, so operator-authored skill
 * descriptions are deliberately withheld from it; `GetExtendedAgentCard` returns
 * the richer authenticated variant instead.
 */
export function buildA2aAgentCard(params: A2aAgentCardParams): A2aAgentCard {
  const origin = resolveAdvertisedOrigin(params);
  // listAgentIds reads both the canonical `agents.entries` roster and the legacy
  // `agents.list` projection; reading either shape directly publishes a
  // skill-less card to every peer whose operator configured the other one.
  const exposed = params.a2aConfig.exposeAgents;
  const agentIds = listAgentIds(params.config).filter(
    (agentId) => !exposed?.length || exposed.includes(agentId),
  );
  const instanceName =
    (agentIds[0] ? resolveAgentConfig(params.config, agentIds[0])?.name?.trim() : undefined) ||
    params.a2aConfig.displayName?.trim() ||
    "OpenClaw";

  const interfaces: A2aAgentInterface[] = [
    {
      url: `${origin}${A2A_JSONRPC_PATH}`,
      protocolBinding: A2A_JSONRPC_BINDING,
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ];
  if (params.a2aConfig.rest?.enabled === true) {
    interfaces.push({
      url: `${origin}${A2A_REST_PATH}`,
      protocolBinding: A2A_REST_BINDING,
      protocolVersion: A2A_PROTOCOL_VERSION,
    });
  }

  // Only publish the optional capability keys that are actually enabled: the
  // public card is asserted key-for-key by discovery tests, and an absent key
  // reads as "false" per the specification anyway.
  const capabilities: A2aAgentCapabilities = {
    streaming: params.capabilities.streaming,
    pushNotifications: params.capabilities.pushNotifications,
    ...(params.capabilities.extendedAgentCard ? { extendedAgentCard: true } : {}),
  };
  const extensions = resolveExtensions(params.a2aConfig);
  if (extensions) {
    capabilities.extensions = extensions;
  }

  const skills: A2aAgentSkill[] = agentIds.map((agentId) => {
    const agent = resolveAgentConfig(params.config, agentId);
    // The public card publishes only the agent id; operator-authored text and
    // display names stay behind the authenticated extended card.
    const name = params.extended ? agent?.name?.trim() || agentId : agentId;
    const description =
      params.extended && params.a2aConfig.extendedSkillDescriptions?.[agentId]?.trim()
        ? params.a2aConfig.extendedSkillDescriptions[agentId]!.trim()
        : `OpenClaw agent ${agentId}.`;
    return {
      id: agentId,
      name,
      description,
      tags: ["openclaw"],
      inputModes: params.a2aConfig.inputModes ?? ["text/plain"],
      outputModes: params.a2aConfig.outputModes ?? ["text/plain"],
    };
  });

  return {
    name: instanceName,
    description:
      params.a2aConfig.description?.trim() ||
      "OpenClaw agent gateway using the Agent2Agent protocol.",
    supportedInterfaces: interfaces,
    version: params.version,
    ...(params.a2aConfig.documentationUrl
      ? { documentationUrl: params.a2aConfig.documentationUrl }
      : {}),
    ...(params.a2aConfig.provider
      ? {
          provider: {
            ...(params.a2aConfig.provider.organization
              ? { organization: params.a2aConfig.provider.organization }
              : {}),
            ...(params.a2aConfig.provider.url ? { url: params.a2aConfig.provider.url } : {}),
          },
        }
      : {}),
    ...(params.a2aConfig.iconUrl ? { iconUrl: params.a2aConfig.iconUrl } : {}),
    capabilities,
    // Peers authenticate with the same bearer token configured per peer, so the
    // card advertises it rather than leaving authentication undiscoverable.
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: params.a2aConfig.inputModes ?? ["text/plain"],
    defaultOutputModes: params.a2aConfig.outputModes ?? ["text/plain"],
    skills,
  };
}
