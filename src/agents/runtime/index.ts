/**
 * Agent Runtime — Factory and public exports.
 *
 * Usage:
 *   import { createRuntime } from "./agents/runtime/index.js";
 *   const runtime = createRuntime("claude-sdk");
 *   const session = await runtime.createSession({ ... });
 */

export type {
  AgentRuntime,
  CreateSessionOptions,
  MessageContent,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  RuntimeToolDefinition,
  RuntimeToolResult,
  RuntimeType,
  SessionStore,
  ThinkLevel,
} from "./types.js";

export { fromPiAgentEvent, fromClaudeSdkMessage } from "./event-bridge.js";
export { fromPiAgentTool, fromPiAgentTools, toClaudeSdkMcpTool } from "./tool-bridge.js";

import type { AgentRuntime, RuntimeType } from "./types.js";

/**
 * Create an agent runtime of the specified type.
 *
 * @param type - Which runtime to use. Defaults to config or "pi-agent" for backward compat.
 */
export function createRuntime(type: RuntimeType = "pi-agent"): AgentRuntime {
  switch (type) {
    case "claude-sdk": {
      // Dynamic import to avoid bundling the SDK when not used
      const { createClaudeSdkRuntime } = require("./claude-sdk-runtime.js");
      return createClaudeSdkRuntime();
    }
    case "pi-agent":
    default: {
      const { createPiAgentRuntime } = require("./pi-runtime.js");
      return createPiAgentRuntime();
    }
  }
}

/**
 * Resolve the runtime type from configuration or environment.
 *
 * Accepts either a flat `{ agentRuntime }` or the full OpenClaw config
 * where the field lives at `agents.defaults.runtime`.
 */
export function resolveRuntimeType(config?: {
  agentRuntime?: string;
  agents?: { defaults?: { runtime?: string } };
}): RuntimeType {
  // Check environment variable first
  const envRuntime = process.env.OPENCLAW_AGENT_RUNTIME;
  if (envRuntime === "claude-sdk") {
    return "claude-sdk";
  }
  if (envRuntime === "pi-agent") {
    return "pi-agent";
  }

  // Check flat config
  if (config?.agentRuntime === "claude-sdk") {
    return "claude-sdk";
  }

  // Check nested OpenClaw config
  if (config?.agents?.defaults?.runtime === "claude-sdk") {
    return "claude-sdk";
  }

  // Default to pi-agent for backward compatibility
  return "pi-agent";
}
