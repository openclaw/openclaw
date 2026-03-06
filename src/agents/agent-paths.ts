import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

function resolveDefaultAgentDir(): string {
  return resolveUserPath(path.join(resolveStateDir(), "agents", DEFAULT_AGENT_ID, "agent"));
}

function isLegacyDefaultAgentDir(override: string): boolean {
  const legacyDefault = resolveUserPath("~/.openclaw/agents/main/agent");
  return path.resolve(resolveUserPath(override)) === path.resolve(legacyDefault);
}

export function resolveOpenClawAgentDir(): string {
  const override =
    process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    const stateOverride =
      process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
    if (stateOverride && isLegacyDefaultAgentDir(override)) {
      return resolveDefaultAgentDir();
    }
    return resolveUserPath(override);
  }
  return resolveDefaultAgentDir();
}

export function ensureOpenClawAgentEnv(): string {
  const dir = resolveOpenClawAgentDir();
  if (!process.env.OPENCLAW_AGENT_DIR) {
    process.env.OPENCLAW_AGENT_DIR = dir;
  }
  if (!process.env.PI_CODING_AGENT_DIR) {
    process.env.PI_CODING_AGENT_DIR = dir;
  }
  return dir;
}
