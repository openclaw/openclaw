import type { OpenClawConfig } from "../config/types.openclaw.js";

type AgentRuntimeMetadata = {
  id: string;
  source: "implicit";
};

export function resolveAgentRuntimeMetadata(
  _cfg: OpenClawConfig,
  _agentId: string,
  _env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeMetadata {
  return {
    id: "auto",
    source: "implicit",
  };
}
