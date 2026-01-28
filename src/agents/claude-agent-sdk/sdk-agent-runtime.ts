/**
 * SDK Agent runtime — wraps `runSdkAgentAdapted` behind the AgentRuntime interface.
 *
 * The factory function captures SDK-specific parameters (bridged tools and
 * conversation history) at construction time so the caller only needs to
 * pass the common `AgentRuntimeRunParams` at run time.
 */

import type { AgentRuntime, AgentRuntimeRunParams, AgentRuntimeResult } from "../agent-runtime.js";
import type { AnyAgentTool } from "../tools/common.js";
import { runSdkAgentAdapted } from "./sdk-runner-adapter.js";
import type { SdkConversationTurn } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// SDK-specific context
// ---------------------------------------------------------------------------

/** SDK-specific parameters captured at factory creation time. */
export type SdkRuntimeContext = {
  /** Clawdbrain tools bridged to the SDK via MCP. */
  tools: AnyAgentTool[];
  /** Prior conversation history serialized for the SDK. */
  conversationHistory?: SdkConversationTurn[];
  /** Enable Claude Code hook wiring for richer event parity. */
  hooksEnabled?: boolean;
  /** Additional `query({ options })` fields to pass through. */
  sdkOptions?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Claude Agent SDK runtime instance.
 *
 * @param context - SDK-specific parameters (tools, conversation history).
 * @returns An `AgentRuntime` that delegates to `runSdkAgentAdapted`.
 */
export function createSdkAgentRuntime(context: SdkRuntimeContext): AgentRuntime {
  return {
    kind: "sdk",
    displayName: "Claude Agent SDK",
    async run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult> {
      return runSdkAgentAdapted({
        ...params,
        ...context,
      });
    },
  };
}
