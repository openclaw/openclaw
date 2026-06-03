import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

const agentIdByDir = new Map<string, string>();

function normalizeAgentDirKey(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveUserPath(agentDir, env));
}

export function registerResolvedAgentDir(params: {
  agentId: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): void {
  agentIdByDir.set(
    normalizeAgentDirKey(params.agentDir, params.env),
    normalizeAgentId(params.agentId),
  );
}

export function resolveRegisteredAgentIdForDir(
  agentDir: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  return agentIdByDir.get(normalizeAgentDirKey(agentDir, env));
}
