import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentExecutionContract, resolveSessionAgentIds } from "./agent-scope.js";

export function isStrictAgenticExecutionContractActive(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string | null;
}): boolean {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId ?? undefined,
  });
  return resolveAgentExecutionContract(params.config, sessionAgentId) === "strict-agentic";
}
