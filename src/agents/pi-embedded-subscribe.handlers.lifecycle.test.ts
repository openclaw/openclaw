import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: { onAgentEvent?: (event: unknown) => void },
): EmbeddedPiSubscribeContext {
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedPiSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      blockState: {
        thinking: true,
        final: true,
        inlineCode: createInlineCodeState(),
      },
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    flushBlockReplyBuffer: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleAgentEnd", () => {
  it("logs the resolved error message when run ends with assistant error", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("runId=run-1");
    expect(warn.mock.calls[0]?.[0]).toContain("error=connection refused");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "connection refused",
      },
    });
  });

  it("keeps non-error run-end logging on debug only", () => {
    const ctx = createContext(undefined);

    handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });
});
