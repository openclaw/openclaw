import path from "node:path";

import { CONFIG_DIR, resolveUserPath } from "../utils.js";

const DEFAULT_AGENT_DIR = path.join(CONFIG_DIR, "agent");

export function resolveClawdbotAgentDir(): string {
  const override =
    process.env.CLAWDBOT_AGENT_DIR?.trim() ||
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    DEFAULT_AGENT_DIR;
  return resolveUserPath(override);
}

export function ensureClawdbotAgentEnv(): string {
  const dir = resolveClawdbotAgentDir();
  if (!process.env.CLAWDBOT_AGENT_DIR) process.env.CLAWDBOT_AGENT_DIR = dir;
  if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}
