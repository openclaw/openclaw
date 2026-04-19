// Read the active agent's configured runtime driver.
//
// Default is the legacy pi-embedded path (compat with every existing
// deployment). Opt into the Claude Agent SDK per-agent by setting
// `agents.list[<agentId>].runtime.type = "claude-sdk"`. Opt into ACP
// via `"acp"`. Anything else (missing agent, missing runtime field,
// explicit `"embedded"`) stays on the legacy path.
//
// Phase 4 may flip the default once the claude-sdk runtime has soaked
// against real user traffic; this PR intentionally keeps the flip out
// so environments without `@anthropic-ai/claude-code` installed
// (e.g. the parity-gate CI mock) keep working.

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
    // the default (legacy pi-embedded) runtime.
    return "default";
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
  // Only explicit claude-sdk opt-in routes to the SDK. Everything
  // else falls back to the legacy path.
  if (explicit === "claude-sdk") {
    return "claude-sdk";
  }
  return "default";
}
