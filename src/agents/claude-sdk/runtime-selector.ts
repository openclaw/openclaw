// Read the active agent's configured runtime driver. Returns
// `"claude-sdk"` only when the agent explicitly opts in via
// `agents.list[<agentId>].runtime.type`. All other shapes (missing
// agent, missing runtime, `embedded`, `acp`) fall back to `"default"`,
// which preserves the legacy pi-embedded code path.

import type { OpenClawConfig } from "../../config/config.js";
import { listAgentEntries } from "../agent-scope.js";

export type ClaudeSdkRuntimeSelection = "claude-sdk" | "default";

export function selectAgentRuntime(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): ClaudeSdkRuntimeSelection {
  if (!agentId) {
    return "default";
  }
  const entry = listAgentEntries(cfg).find((e) => e.id === agentId);
  return entry?.runtime?.type === "claude-sdk" ? "claude-sdk" : "default";
}
