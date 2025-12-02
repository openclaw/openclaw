import { claudeSpec } from "./claude.js";
import { codexSpec } from "./codex.js";
import { opencodeSpec } from "./opencode.js";
import { piSpec } from "./pi.js";
import type { AgentKind, AgentSpec } from "./types.js";

const specs: Record<AgentKind, AgentSpec> = {
  claude: claudeSpec,
  codex: codexSpec,
  opencode: opencodeSpec,
  pi: piSpec,
};

export function getAgentSpec(kind: AgentKind): AgentSpec {
  return specs[kind];
}

export { AgentKind, AgentMeta, AgentParseResult } from "./types.js";
