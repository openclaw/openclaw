// Unified entry point for driving a single agent turn. Reads the
// per-agent runtime selector and dispatches to either the legacy
// pi-embedded runtime or the Claude Agent SDK adapter.
//
// Use this from every production caller that would otherwise call
// `runEmbeddedPiAgent(...)` directly. The dispatch is a thin wrapper —
// it imports the claude-sdk adapter dynamically to honor the repo's
// dynamic-import guardrail (AGENTS.md), while the legacy path remains
// statically imported so callers that still explicitly opt into
// `runtime.type: "embedded"` incur zero change in bundle shape.
//
// Tests that mock `runEmbeddedPiAgent` via `vi.mock("../pi-embedded.js")`
// continue to work unchanged because the legacy branch forwards there.

import type { EmbeddedPiRunResult } from "./pi-embedded.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import { selectAgentRuntime } from "./claude-sdk/runtime-selector.js";

/**
 * Stable result type for `runAgent`, independent of the underlying
 * driver (claude-sdk, pi-embedded, or ACP).
 *
 * Today this aliases `EmbeddedPiRunResult` for backward compatibility
 * with existing callers that already imported that name. Once the
 * pi-embedded runtime is retired in the Phase 4 deletion, this alias
 * becomes the canonical type and the legacy name goes with it.
 *
 * New call sites should import `RunAgentResult` from here rather than
 * reaching into pi-embedded types.
 */
export type RunAgentResult = EmbeddedPiRunResult;

/**
 * Parameter type for `runAgent`. Aliased from the pi-embedded runner's
 * param shape so the dispatch is transparent to callers during the
 * compat window. Renamed in the Phase 4 deletion.
 */
export type RunAgentParams = RunEmbeddedPiAgentParams;

/**
 * Drive one agent run. Picks the active runtime from the agent's config
 * entry (`agents.list[<agentId>].runtime.type`) and dispatches
 * accordingly. Return shape is stable across drivers (`RunAgentResult`).
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const runtime = params.config
    ? selectAgentRuntime(params.config, params.agentId)
    : "default";
  if (runtime === "claude-sdk") {
    const mod = await import("./claude-sdk/run.runtime.js");
    return mod.runClaudeSdkAgent(params);
  }
  return runEmbeddedPiAgent(params);
}
