import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompletionsContentFlattenWrapper } from "./openai-stream-wrappers.js";

describe("createOpenAICompletionsContentFlattenWrapper", () => {
  it("flattens assistant content arrays to strings for openai-completions", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const fakeStream = vi.fn(
      (_model: unknown, _context: unknown, options?: { onPayload?: Function }) => {
        const payload = {
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            {
              role: "assistant",
              content: [{ type: "text", text: "I'll run the command..." }],
              tool_calls: [{ id: "call_1", type: "function", function: { name: "exec" } }],
            },
            { role: "tool", content: "ok", tool_call_id: "call_1" },
          ],
        };
        options?.onPayload?.(payload, "test-model");
        capturedPayload = payload;
        return {};
      },
    );

    const wrapped = createOpenAICompletionsContentFlattenWrapper(fakeStream as unknown as StreamFn);
    void wrapped(
      { api: "openai-completions" } as Parameters<StreamFn>[0],
      {} as Parameters<StreamFn>[1],
      {},
    );

    const msgs = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    // Assistant content should be flattened to string
    expect(msgs[1].content).toBe("I'll run the command...");
    // User content should remain unchanged (only assistant is flattened)
    expect(Array.isArray(msgs[0].content)).toBe(true);
  });

  it("sets content to null when no text parts exist", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const fakeStream = vi.fn(
      (_model: unknown, _context: unknown, options?: { onPayload?: Function }) => {
        const payload = {
          messages: [
            {
              role: "assistant",
              content: [{ type: "image", url: "http://example.com/img.png" }],
              tool_calls: [{ id: "call_1" }],
            },
          ],
        };
        options?.onPayload?.(payload, "test-model");
        capturedPayload = payload;
        return {};
      },
    );

    const wrapped = createOpenAICompletionsContentFlattenWrapper(fakeStream as unknown as StreamFn);
    void wrapped(
      { api: "openai-completions" } as Parameters<StreamFn>[0],
      {} as Parameters<StreamFn>[1],
      {},
    );

    const msgs = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    expect(msgs[0].content).toBeNull();
  });

  it("skips non-openai-completions models", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const fakeStream = vi.fn(
      (_model: unknown, _context: unknown, options?: { onPayload?: Function }) => {
        const payload = {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "keep me" }],
            },
          ],
        };
        options?.onPayload?.(payload, "test-model");
        capturedPayload = payload;
        return {};
      },
    );

    const wrapped = createOpenAICompletionsContentFlattenWrapper(fakeStream as unknown as StreamFn);
    void wrapped(
      { api: "anthropic-messages" } as Parameters<StreamFn>[0],
      {} as Parameters<StreamFn>[1],
      {},
    );

    const msgs = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    // Should remain as array since not openai-completions
    expect(Array.isArray(msgs[0].content)).toBe(true);
  });
});
