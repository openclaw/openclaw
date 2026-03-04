import { describe, expect, it, vi } from "vitest";
import type { CliBackendConfig } from "../config/types.js";
import { createStreamJsonProcessor } from "./cli-runner/helpers.js";

function createBackend(overrides: Partial<CliBackendConfig> = {}): CliBackendConfig {
  return {
    command: "claude",
    output: "stream-json",
    ...overrides,
  };
}

describe("createStreamJsonProcessor", () => {
  it("emits thinking/tool events while preserving final assistant output", () => {
    const onAssistantTurn = vi.fn();
    const onThinkingTurn = vi.fn();
    const onToolUse = vi.fn();
    const onToolUseEvent = vi.fn();
    const onToolResult = vi.fn();

    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
      onThinkingTurn,
      onToolUse,
      onToolUseEvent,
      onToolResult,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check inputs first" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { path: "README.md" },
            },
            { type: "text", text: "Working on it..." },
          ],
        },
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "README contents" }],
            },
          ],
        },
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "result",
        result: "Final answer",
        session_id: "session-1",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
        },
      })}\n`,
    );

    const output = processor.finish();

    expect(onAssistantTurn).toHaveBeenCalledWith("Working on it...");
    expect(onThinkingTurn).toHaveBeenCalledWith({
      text: "Check inputs first",
      delta: "Check inputs first",
    });
    expect(onToolUse).toHaveBeenCalledWith("Read");
    expect(onToolUseEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Read",
        toolUseId: "toolu_1",
        input: { path: "README.md" },
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: "toolu_1",
        text: "README contents",
        isError: false,
      }),
    );
    expect(output).toEqual({
      text: "Final answer",
      sessionId: "session-1",
      usage: {
        input: 12,
        output: 8,
        total: 20,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
    });
  });

  it("deduplicates tool_use blocks by id and computes thinking deltas", () => {
    const onThinkingTurn = vi.fn();
    const onToolUseEvent = vi.fn();

    const processor = createStreamJsonProcessor(createBackend(), {
      onThinkingTurn,
      onToolUseEvent,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Plan" },
            { type: "tool_use", id: "toolu_repeat", name: "Search", input: { q: "a" } },
          ],
        },
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Planning next step" },
            { type: "tool_use", id: "toolu_repeat", name: "Search", input: { q: "a" } },
          ],
        },
      })}\n`,
    );

    processor.finish();

    expect(onThinkingTurn).toHaveBeenNthCalledWith(1, {
      text: "Plan",
      delta: "Plan",
    });
    expect(onThinkingTurn).toHaveBeenNthCalledWith(2, {
      text: "Planning next step",
      delta: "ning next step",
    });
    expect(onToolUseEvent).toHaveBeenCalledTimes(1);
  });

  it("omits thinking delta when text is rewritten instead of appended", () => {
    const onThinkingTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onThinkingTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "First draft" }],
        },
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Rewritten idea" }],
        },
      })}\n`,
    );

    processor.finish();
    expect(onThinkingTurn).toHaveBeenNthCalledWith(1, {
      text: "First draft",
      delta: "First draft",
    });
    expect(onThinkingTurn).toHaveBeenNthCalledWith(2, {
      text: "Rewritten idea",
    });
  });

  it("deduplicates consecutive anonymous tool_use blocks", () => {
    const onToolUseEvent = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onToolUseEvent,
    });

    const anonymousToolUseLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Search", input: { q: "hello" } }],
      },
    });
    processor.feed(`${anonymousToolUseLine}\n`);
    processor.feed(`${anonymousToolUseLine}\n`);
    processor.finish();

    expect(onToolUseEvent).toHaveBeenCalledTimes(1);
    expect(onToolUseEvent).toHaveBeenCalledWith({
      name: "Search",
      input: { q: "hello" },
      toolUseId: undefined,
    });
  });

  it("keeps backward compatibility for assistant content emitted as a string", () => {
    const onAssistantTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: "legacy assistant content",
        },
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).toHaveBeenCalledWith("legacy assistant content");
    expect(output.text).toBe("legacy assistant content");
  });

  it("keeps backward compatibility for assistant message emitted as a raw string", () => {
    const onAssistantTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: "legacy raw assistant message",
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).toHaveBeenCalledWith("legacy raw assistant message");
    expect(output.text).toBe("legacy raw assistant message");
  });

  it("ignores non-assistant text blocks while still emitting tool_result blocks", () => {
    const onAssistantTurn = vi.fn();
    const onToolResult = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
      onToolResult,
    });

    processor.feed(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "user text should not stream as assistant" }],
        },
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_from_user_turn",
              content: [{ type: "text", text: "tool output" }],
            },
          ],
        },
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: "toolu_from_user_turn",
        text: "tool output",
      }),
    );
    expect(output.text).toBe("");
  });

  it("ignores tool_result blocks from system envelopes", () => {
    const onToolResult = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onToolResult,
    });

    processor.feed(
      `${JSON.stringify({
        type: "system",
        message: {
          role: "system",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_system",
              content: [{ type: "text", text: "system should not emit tool_result" }],
            },
          ],
        },
      })}\n`,
    );

    processor.finish();
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("keeps result handling when result payload includes content blocks", () => {
    const onAssistantTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "result",
        session_id: "session-with-blocks",
        message: {
          role: "system",
          content: [{ type: "text", text: "final from result blocks" }],
        },
        usage: {
          input_tokens: 4,
          output_tokens: 3,
          total_tokens: 7,
        },
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).not.toHaveBeenCalled();
    expect(output).toEqual({
      text: "final from result blocks",
      sessionId: "session-with-blocks",
      usage: {
        input: 4,
        output: 3,
        total: 7,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
    });
  });

  it("deduplicates identical tool_result blocks by tool_use_id", () => {
    const onToolResult = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onToolResult,
    });

    const event = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_dup",
            content: [{ type: "text", text: "same output" }],
          },
        ],
      },
    };
    processor.feed(`${JSON.stringify(event)}\n`);
    processor.feed(`${JSON.stringify(event)}\n`);

    processor.finish();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "toolu_dup",
      text: "same output",
      isError: false,
    });
  });

  it("falls back to collectText when assistant content blocks are non-standard", () => {
    const onAssistantTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text_delta", text: "delta text fallback" }],
        },
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).toHaveBeenCalledWith("delta text fallback");
    expect(output.text).toBe("delta text fallback");
  });

  it("handles unknown top-level envelope types without requiring exhaustive enumeration", () => {
    const onAssistantTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "custom_agent_event",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "message from unknown envelope type" }],
        },
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).toHaveBeenCalledWith("message from unknown envelope type");
    expect(output.text).toBe("message from unknown envelope type");
  });

  it("emits system init callbacks with resolved session id", () => {
    const onSystemInit = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onSystemInit,
    });

    processor.feed(
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-init-1",
      })}\n`,
    );

    processor.finish();

    expect(onSystemInit).toHaveBeenCalledTimes(1);
    expect(onSystemInit).toHaveBeenCalledWith({
      subtype: "init",
      sessionId: "session-init-1",
    });
  });

  it("ignores rate_limit_event envelopes while preserving assistant stream output", () => {
    const onAssistantTurn = vi.fn();
    const processor = createStreamJsonProcessor(createBackend(), {
      onAssistantTurn,
    });

    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "part 1" }],
        },
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "rate_limit_event",
        current_requests_per_minute: 10,
      })}\n`,
    );
    processor.feed(
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "part 2" }],
        },
      })}\n`,
    );

    const output = processor.finish();
    expect(onAssistantTurn).toHaveBeenCalledTimes(2);
    expect(onAssistantTurn).toHaveBeenNthCalledWith(1, "part 1");
    expect(onAssistantTurn).toHaveBeenNthCalledWith(2, "part 2");
    expect(output.text).toBe("part 2");
  });
});
