/**
 * A2A Agent Card builder — generates an A2A-compliant agent card from
 * OpenClaw agent configuration.
 */

interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version?: string;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  capabilities: A2AAgentCapabilities;
  skills: A2AAgentSkill[];
  agents?: string[];
}

function buildSkillFromAgent(
  agentId: string,
  description?: string,
): A2AAgentSkill {
  return {
    id: agentId,
    name: agentId,
    description,
    tags: ["openclaw"],
    inputModes: ["text"],
    outputModes: ["text"],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentEntry = { id: string; description?: string };

export function buildAgentCard(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: AgentEntry[];
  gatewayUrl: string;
}): A2AAgentCard {
  const { agents, gatewayUrl } = params;

  const skills: A2AAgentSkill[] = agents.map((a) =>
    buildSkillFromAgent(a.id, a.description),
  );

  return {
    name: "OpenClaw",
    description:
      "OpenClaw AI agent — multi-model, multi-channel personal assistant with tool use, memory, and cross-agent coordination.",
    url: gatewayUrl,
    version: "2026.7.0",
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills,
    agents: agents.map((a) => a.id),
  };
}
