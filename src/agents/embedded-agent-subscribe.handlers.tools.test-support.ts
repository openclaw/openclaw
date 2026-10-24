import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { vi } from "vitest";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";

export type ToolExecutionEndEvent = Omit<
  Extract<AgentEvent, { type: "tool_execution_end" }>,
  "type" | "isError"
> & { isError?: boolean };

export function endTool(ctx: ToolHandlerContext, event: ToolExecutionEndEvent) {
  return handleToolExecutionEnd(
    ctx,
    { type: "tool_execution_end", isError: false, ...event },
    prepareToolResult(event.result),
  );
}

export function resultWithDetails(details: Record<string, unknown>) {
  return { details };
}

export type CapturedAgentEvent = { stream?: string; data?: Record<string, unknown> };

export function requireEvent(
  events: CapturedAgentEvent[],
  predicate: (event: CapturedAgentEvent) => boolean,
  label: string,
): CapturedAgentEvent {
  const event = events.find(predicate);
  if (!event) {
    throw new Error(`expected ${label} event`);
  }
  return event;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export function createTestContext() {
  const onBlockReplyFlush = vi.fn<NonNullable<ToolHandlerContext["params"]["onBlockReplyFlush"]>>();
  const onAgentEvent = vi.fn();
  const onExecutionPhase = vi.fn();
  const warn = vi.fn();
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      sessionKey: "agent:unit-session",
      sessionId: "session-test-id",
      agentId: "agent-test-id",
      onBlockReplyFlush,
      onAgentEvent,
      onExecutionPhase,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
    },
    state: new EmbeddedAgentSubscribeState({}),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush, onAgentEvent, onExecutionPhase };
}
