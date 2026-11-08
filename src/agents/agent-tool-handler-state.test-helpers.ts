import { vi } from "vitest";
import { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";

export function createBaseToolHandlerState() {
  return new EmbeddedAgentSubscribeState({});
}

export function createToolHandlerMocks(warn = vi.fn()) {
  return {
    state: createBaseToolHandlerState(),
    log: { debug: vi.fn(), info: vi.fn(), warn },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}
