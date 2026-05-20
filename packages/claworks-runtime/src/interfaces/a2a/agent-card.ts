import type { ClaworksRuntime } from "../../claworks/runtime.js";
import type { A2aAgentCard } from "./types.js";

export function buildA2aAgentCard(runtime: ClaworksRuntime, baseUrl?: string): A2aAgentCard {
  const url = baseUrl ?? runtime.robot.endpoint;
  return {
    name: runtime.robot.name,
    description: "ClaWorks industrial robot",
    url,
    version: runtime.robot.version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: runtime.playbookEngine.list().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    })),
    endpoints: {
      tasks: `${url.replace(/\/$/, "")}/a2a/tasks`,
    },
    claworks: {
      role: runtime.robot.role,
      playbooks: runtime.playbookEngine.list().map((p) => p.id),
      objectTypes: runtime.ontology.listTypes().map((t) => t.name),
    },
  };
}
