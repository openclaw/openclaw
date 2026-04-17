// Unified entry point for driving a single agent turn. Reads the
// per-agent runtime selector and dispatches to either the legacy
// pi-embedded runtime or the Claude Agent SDK adapter.
//
// Use this from every production caller that would otherwise call
// `runEmbeddedPiAgent(...)` directly. The dispatch is a thin wrapper —
// it imports the claude-sdk adapter dynamically to honor the repo's
// dynamic-import guardrail (AGENTS.md), while the default path remains
// statically imported so callers that never flip the flag incur zero
// change in behavior or bundle shape.
//
// Tests that mock `runEmbeddedPiAgent` via `vi.mock("../pi-embedded.js")`
// continue to work unchanged because the default branch forwards there.

import type { EmbeddedPiRunResult } from "./pi-embedded.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import { selectAgentRuntime } from "./claude-sdk/runtime-selector.js";

/**
 * Drive one agent run. Picks the active runtime from the agent's config
 * entry (`agents.list[<agentId>].runtime.type`) and dispatches
 * accordingly. Return shape matches `EmbeddedPiRunResult` regardless of
 * which runtime handled the call.
 */
export async function runAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult> {
  const runtime = params.config
    ? selectAgentRuntime(params.config, params.agentId)
    : "default";
  if (runtime === "claude-sdk") {
    const mod = await import("./claude-sdk/run.runtime.js");
    return mod.runClaudeSdkAgent(params);
  }
  return runEmbeddedPiAgent(params);
}
