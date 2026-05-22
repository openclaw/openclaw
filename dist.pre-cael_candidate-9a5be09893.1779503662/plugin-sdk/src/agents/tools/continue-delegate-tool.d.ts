import type { AnyAgentTool } from "./common.js";
/**
 * Creates the `continue_delegate` tool.
 *
 * This tool dispatches a sub-agent as a continuation delegate — tracked by the
 * gateway's continuation chain (cost caps, depth limits, chain counters).
 *
 * Architecture (Path A — side-channel):
 *   1. Tool writes to the module-level pending-delegate store during execution.
 *   2. After the agent's response finalizes, `agent-runner.ts` reads from the
 *      store and feeds delegates into the same scheduler that bracket-parsed
 *      `[[CONTINUE_DELEGATE:]]` signals use.
 *   3. Both paths (tool + brackets) converge at the same dispatch point —
 *      same cost cap, same chain depth, same delay clamping.
 *
 * The tool can be called multiple times per turn (multi-delegate fan-out).
 * Each call enqueues independently. No single-per-response regex limitation.
 *
 * No generation guard — delayed delegates survive channel noise (RFC
 * 2026-04-15: unrelated inbound traffic does not cancel scheduled work).
 */
export declare function createContinueDelegateTool(opts: {
    agentSessionKey?: string;
}): AnyAgentTool;
