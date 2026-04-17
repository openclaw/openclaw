// Read the active agent's configured runtime driver. Returns
// `"claude-sdk"` by default (the active production runtime as of Phase 3
// of the agent-runtime migration), unless the agent has explicitly
// opted in to the legacy `"embedded"` or `"acp"` path via
// `agents.list[<agentId>].runtime.type`.
//
// The legacy pi-embedded path is kept alive through the compat window
// so the default flip can be reverted per-agent by setting
// `runtime.type: "embedded"`. Full removal happens in Phase 4 once
// real user traffic confirms the claude-sdk default is stable.

import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries } from "../agent-scope.js";

export type ClaudeSdkRuntimeSelection = "claude-sdk" | "default";

export function selectAgentRuntime(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): ClaudeSdkRuntimeSelection {
  if (!agentId) {
    // No agent id means we have no per-agent override to consult. Use
    // the default runtime.
    return "claude-sdk";
  }
  // Normalize both sides. Elsewhere in the codebase, agent IDs are
  // lowercased/sanitized via normalizeAgentId before routing, so an
  // entry declared as `id: "MyAgent"` resolves and runs at "myagent".
  // A raw `===` match here would miss that casing difference and
  // silently route to the wrong runtime.
  const normalizedTarget = normalizeAgentId(agentId);
  const entry = listAgentEntries(cfg).find(
    (e) => normalizeAgentId(e.id) === normalizedTarget,
  );
  const explicit = entry?.runtime?.type;
  // Explicit legacy opt-ins keep the legacy (pi-embedded / acp) path.
  // Everything else -- missing agent, missing runtime field, or explicit
  // `claude-sdk` -- uses the Claude Agent SDK.
  if (explicit === "embedded" || explicit === "acp") {
    return "default";
  }
  return "claude-sdk";
}
