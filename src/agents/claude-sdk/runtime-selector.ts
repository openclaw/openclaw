// Read the active agent's configured runtime driver. Returns
// `"claude-sdk"` only when the agent has explicitly opted in via
// `agents.list[<agentId>].runtime.type: "claude-sdk"`. All other shapes
// (missing agent, missing runtime, `embedded`, `acp`) fall back to
// `"default"`, which preserves the legacy pi-embedded code path.
//
// NOTE ON THE PHASE 3 FLIP: an earlier revision of this file defaulted
// to `"claude-sdk"` for agents that omit `runtime.type`. That flip was
// reverted because the auto-reply test harness mocks
// `runEmbeddedPiAgent`, and routing through `runClaudeSdkAgent` by
// default bypassed those mocks and regressed ~24 tests. The opt-in
// driver remains available; flipping the default is deferred until the
// test harness is updated to mock the unified `runAgent` dispatch seam
// (tracked under Phase 4 preparation).

import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries } from "../agent-scope.js";

export type ClaudeSdkRuntimeSelection = "claude-sdk" | "default";

export function selectAgentRuntime(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): ClaudeSdkRuntimeSelection {
  if (!agentId) {
    return "default";
  }
  // Normalize both sides. Elsewhere in the codebase, agent IDs are
  // lowercased/sanitized via normalizeAgentId before routing, so an
  // entry declared as `id: "MyAgent"` resolves and runs at "myagent".
  // If we did a raw `===` match here, the same agent would silently
  // fall back to the embedded runtime instead of hitting the claude-sdk
  // path the user configured.
  const normalizedTarget = normalizeAgentId(agentId);
  const entry = listAgentEntries(cfg).find(
    (e) => normalizeAgentId(e.id) === normalizedTarget,
  );
  return entry?.runtime?.type === "claude-sdk" ? "claude-sdk" : "default";
}
