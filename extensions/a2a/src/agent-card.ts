import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type { A2APluginConfig } from "./config.js";

type IdentityConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number]["identity"]
>;

function resolveAgentIdentity(cfg: OpenClawConfig, agentId: string): IdentityConfig | undefined {
  const agents = cfg.agents?.list;
  if (!Array.isArray(agents)) {
    return undefined;
  }
  const entry = agents.find(
    (a) => a && typeof a === "object" && a.id?.toLowerCase() === agentId.toLowerCase(),
  );
  return entry?.identity;
}

function resolveAgentName(cfg: OpenClawConfig, agentId: string): string | undefined {
  const agents = cfg.agents?.list;
  if (!Array.isArray(agents)) {
    return undefined;
  }
  const entry = agents.find(
    (a) => a && typeof a === "object" && a.id?.toLowerCase() === agentId.toLowerCase(),
  );
  return entry?.name ?? entry?.identity?.name;
}

/**
 * Build skills from agent's registered tools.
 * For now, returns a single generic skill since tools are context-dependent.
 */
function buildSkillsFromConfig(cfg: OpenClawConfig, agentId: string): AgentSkill[] {
  const skills: AgentSkill[] = [];

  // Add a generic assistant skill
  skills.push({
    id: "assistant",
    name: "General Assistant",
    description: "Responds to questions and performs tasks using available tools",
    inputModes: ["text"],
    outputModes: ["text"],
  });

  return skills;
}

export type BuildAgentCardParams = {
  config: OpenClawConfig;
  pluginConfig: A2APluginConfig;
  publicUrl: string;
  authRequired?: boolean;
};

/**
 * Build an A2A Agent Card from OpenClaw's agent identity and configuration.
 */
export function buildAgentCard(params: BuildAgentCardParams): AgentCard {
  const { config, pluginConfig, publicUrl, authRequired } = params;
  const agentId = pluginConfig.agentId ?? "main";

  const identity = resolveAgentIdentity(config, agentId);
  const agentName = resolveAgentName(config, agentId);

  // Build the name with fallbacks
  const name = identity?.name ?? agentName ?? `OpenClaw Agent (${agentId})`;

  // Build the description
  const description = pluginConfig.description ?? "AI assistant powered by OpenClaw";

  // Normalize the base URL (remove trailing slash if present)
  const baseUrl = publicUrl.replace(/\/$/, "");

  const card: AgentCard = {
    name,
    description,
    protocolVersion: "0.3.0",
    version: "1.0.0",
    url: `${baseUrl}/a2a`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: buildSkillsFromConfig(config, agentId),
  };

  // Advertise security requirements when auth is enabled
  if (authRequired) {
    (card as Record<string, unknown>).securitySchemes = {
      a2aApiKey: {
        type: "apiKey",
        name: "Authorization",
        in: "header",
      },
    };
    (card as Record<string, unknown>).security = [{ a2aApiKey: [] }];
  }

  return card;
}
