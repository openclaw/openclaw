/**
 * SDK Agent runtime — wraps `runSdkAgentAdapted` behind the AgentRuntime interface.
 *
 * The factory function captures SDK-specific parameters (bridged tools) at
 * construction time so the caller only needs to pass the common
 * `AgentRuntimeRunParams` at run time.
 *
 * Session continuity is handled via the SDK's native `resume` option rather
 * than client-side history serialization.
 */

import type { AgentRuntime, AgentRuntimeRunParams, AgentRuntimeResult } from "../agent-runtime.js";
import type { AnyAgentTool } from "../tools/common.js";
import { runSdkAgentAdapted } from "./sdk-runner-adapter.js";

// ---------------------------------------------------------------------------
// SDK-specific context
// ---------------------------------------------------------------------------

/** SDK-specific parameters captured at factory creation time. */
export type SdkRuntimeContext = {
  /** Clawdbrain tools bridged to the SDK via MCP. */
  tools: AnyAgentTool[];
  /** Enable Claude Code hook wiring for richer event parity. */
  hooksEnabled?: boolean;
  /** Model to use (e.g., "sonnet", "opus", "haiku", or full model ID). */
  model?: string;
  /** Token budget for extended thinking (0 or undefined = disabled). */
  thinkingBudget?: number;
  /** Additional `query({ options })` fields to pass through. */
  sdkOptions?: Record<string, unknown>;
  /** Claude Code session ID from previous run (for native session resume). */
  claudeSessionId?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Claude Agent SDK runtime instance.
 *
 * @param context - SDK-specific parameters (tools, session ID for resume).
 * @returns An `AgentRuntime` that delegates to `runSdkAgentAdapted`.
 */
export function createSdkAgentRuntime(context: SdkRuntimeContext): AgentRuntime {
  return {
    kind: "ccsdk",
    displayName: "Claude Agent SDK",
    async run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult> {
      return runSdkAgentAdapted({
        ...params,
        ...context,
      });
    },
  };
}
