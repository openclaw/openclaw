/**
 * @irisclaw/iris-engine
 *
 * Branded re-export of the iris parallel agent engine.
 * The actual implementation lives in packages/iris-agent-core which overrides
 * @mariozechner/pi-agent-core for the entire dependency tree.
 */

// Re-export the parallel loop functions
export { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";

// Re-export the parallel-capable agent as IrisAgent (our branded name)
export { IrisAgent } from "@mariozechner/pi-agent-core";
export type { IrisAgentOptions } from "./iris-agent.js";

// Re-export all types
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
