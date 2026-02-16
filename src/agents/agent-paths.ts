import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

export function resolveSmartAgentNeoAgentDir(): string {
  const override =
    process.env.SMART_AGENT_NEO_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  const defaultAgentDir = path.join(resolveStateDir(), "agents", DEFAULT_AGENT_ID, "agent");
  return resolveUserPath(defaultAgentDir);
}

export function ensureSmartAgentNeoAgentEnv(): string {
  const dir = resolveSmartAgentNeoAgentDir();
  if (!process.env.SMART_AGENT_NEO_AGENT_DIR) {
    process.env.SMART_AGENT_NEO_AGENT_DIR = dir;
  }
  if (!process.env.PI_CODING_AGENT_DIR) {
    process.env.PI_CODING_AGENT_DIR = dir;
  }
  return dir;
}
