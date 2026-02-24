/**
 * @irisclaw/iris-engine
 *
 * Parallel agent engine for iris-claw.
 * Drop-in replacement for @mariozechner/pi-agent-core's sequential loop.
 */

// Core parallel loop — use these instead of pi-agent-core's agentLoop
export { agentLoop, agentLoopContinue } from "./agent-loop.js";

// Full agent class with parallel execution built-in
export { IrisAgent } from "./iris-agent.js";
export type { IrisAgentOptions } from "./iris-agent.js";

// Re-export types from pi-agent-core for convenience
export type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
