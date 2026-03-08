import { describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
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

  it("emits truncated phase and notifies user when output limit is hit (stopReason=length)", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "partial response..." }],
        usage: {
          output_tokens: 8192,
        },
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    // Should warn about the truncation
    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("embedded run truncated at output limit");
    expect(warn.mock.calls[0]?.[0]).toContain("runId=run-1");

    // Should emit truncated phase event, not end
    const mocked = vi.mocked(emitAgentEvent);
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "truncated",
          stopReason: "length",
        }),
      }),
    );

    // Should notify user via lifecycle stream (consumed by normal onAgentEvent handlers)
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "truncated",
          message: expect.stringContaining("truncated"),
        }),
      }),
    );

    // Should emit terminal end phase so consumers don't hang
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end", truncated: true },
    });
  });

  it("emits truncated phase when output limit is hit (stopReason=max_tokens)", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "max_tokens",
        content: [{ type: "text", text: "partial response..." }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    // Should emit truncated phase for max_tokens as well
    const mocked = vi.mocked(emitAgentEvent);
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "truncated",
          stopReason: "max_tokens",
        }),
      }),
    );

    // Should notify user via lifecycle stream
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "truncated",
        }),
      }),
    );

    // Should emit terminal end phase
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end", truncated: true },
    });
  });
});
