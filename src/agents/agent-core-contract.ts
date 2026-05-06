import {
  Agent as PiAgent,
  runAgentLoop as piRunAgentLoop,
  type AgentMessage as PiAgentMessage,
  type AgentEvent as PiAgentEvent,
  type AgentTool as PiAgentTool,
  type AgentToolResult as PiAgentToolResult,
  type AgentToolUpdateCallback as PiAgentToolUpdateCallback,
  type StreamFn as PiStreamFn,
  type ThinkingLevel as PiThinkingLevel,
} from "@mariozechner/pi-agent-core";

export type AgentMessage = PiAgentMessage;
export type AgentEvent = PiAgentEvent;
export type AgentTool<
  TParameters extends import("typebox").TSchema = import("typebox").TSchema,
  TDetails = unknown,
> = PiAgentTool<TParameters, TDetails>;
export type AgentToolResult<TDetails = unknown> = PiAgentToolResult<TDetails>;
export type AgentToolUpdateCallback<TDetails = unknown> = PiAgentToolUpdateCallback<TDetails>;
export type StreamFn = PiStreamFn;
export type ThinkingLevel = PiThinkingLevel;

export const Agent = PiAgent;
export const runAgentLoop = piRunAgentLoop;
