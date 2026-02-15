import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

/**
 * Validates the defense-in-depth stream guard logic introduced in #16693.
 *
 * During multi-turn tool execution the SDK can append messages that create
 * orphaned tool_result blocks.  The stream guard runs
 * `sanitizeToolUseResultPairing` on the messages passed to `streamFn` before
 * each API call, so even mid-loop orphans are caught.
 */
describe("stream guard: tool pairing sanitization before API call (#16693)", () => {
  it("drops orphaned tool_result that follows a user turn after provider switch", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look that up." },
          { type: "toolCall", id: "call_openai_abc123", name: "search", arguments: "{}" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_openai_abc123",
        toolName: "search",
        content: [{ type: "text", text: "result from search" }],
        isError: false,
      },
      { role: "user", content: "Now summarize that." },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_01XYZ", name: "read", arguments: '{"path":"a.txt"}' },
        ],
      },
      // Orphaned tool_result — leftover from a stale OpenAI call not in context
      {
        role: "toolResult",
        toolCallId: "call_openai_stale999",
        toolName: "exec",
        content: [{ type: "text", text: "stale openai result" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_01XYZ",
        toolName: "read",
        content: [{ type: "text", text: "file content" }],
        isError: false,
      },
    ];

    const sanitized = sanitizeToolUseResultPairing(messages);

    const toolResultIds = sanitized
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as { toolCallId?: string }).toolCallId);

    expect(toolResultIds).not.toContain("call_openai_stale999");
    expect(toolResultIds).toContain("call_openai_abc123");
    expect(toolResultIds).toContain("toolu_01XYZ");
  });

  it("returns same reference for a clean transcript with no tool calls", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    const sanitized = sanitizeToolUseResultPairing(messages);
    expect(sanitized).toBe(messages);
  });

  it("simulates the full stream guard wrapper flow", () => {
    const innerStreamFn = vi.fn();
    const wrapStreamFn = (streamFn: typeof innerStreamFn) => {
      return (model: unknown, context: unknown, options: unknown) => {
        const ctx = context as { messages?: AgentMessage[] };
        if (Array.isArray(ctx.messages) && ctx.messages.length > 0) {
          const sanitized = sanitizeToolUseResultPairing(ctx.messages);
          if (sanitized !== ctx.messages) {
            return streamFn(model, { ...context, messages: sanitized }, options);
          }
        }
        return streamFn(model, context, options);
      };
    };

    const wrappedStreamFn = wrapStreamFn(innerStreamFn);

    const messagesWithOrphan: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_01B", name: "exec", arguments: '{"cmd":"ls"}' }],
      },
      {
        role: "toolResult",
        toolCallId: "call_stale",
        toolName: "unknown",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_01B",
        toolName: "exec",
        content: [{ type: "text", text: "file list" }],
        isError: false,
      },
    ];

    const model = { id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" };
    const context = { system: "You are helpful.", messages: messagesWithOrphan };
    const options = {};

    wrappedStreamFn(model, context, options);

    expect(innerStreamFn).toHaveBeenCalledTimes(1);
    const passedContext = innerStreamFn.mock.calls[0][1] as { messages: AgentMessage[] };
    const resultIds = passedContext.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as { toolCallId?: string }).toolCallId);

    expect(resultIds).toEqual(["toolu_01B"]);
    expect(resultIds).not.toContain("call_stale");
  });
});
