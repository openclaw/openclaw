/**
 * Lightweight identity marker for the built-in OpenClaw harness.
 */
import type { AgentHarness } from "./types.js";

const BUILTIN_OPENCLAW_AGENT_HARNESS = Symbol("openclaw.builtinAgentHarness");

/** Brands the harness object created by OpenClaw's built-in harness factory. */
export function markBuiltinOpenClawAgentHarness(harness: AgentHarness): AgentHarness {
  Object.defineProperty(harness, BUILTIN_OPENCLAW_AGENT_HARNESS, {
    value: true,
    enumerable: false,
  });
  return harness;
}

/** Returns whether a harness object was created by OpenClaw's built-in harness factory. */
export function isBuiltinOpenClawAgentHarness(harness: AgentHarness): boolean {
  return (
    (harness as AgentHarness & { [BUILTIN_OPENCLAW_AGENT_HARNESS]?: true })[
      BUILTIN_OPENCLAW_AGENT_HARNESS
    ] === true
  );
}
