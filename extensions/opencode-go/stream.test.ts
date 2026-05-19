import { describe, expect, it, vi } from "vitest";
import { createOpencodeGoKimiNoReasoningWrapper } from "./stream.js";

type StreamFnArgs = Parameters<
  NonNullable<ReturnType<typeof createOpencodeGoKimiNoReasoningWrapper>>
>;

function captureStrippedPayload(model: { provider: string; id: string }, payload: unknown) {
  const seen: { payload: unknown }[] = [];
  const baseStreamFn = vi.fn((_model, _context, options) => {
    options?.onPayload?.(payload, _model);
    seen.push({ payload });
    return Promise.resolve({ result: "ok" });
  }) as unknown as NonNullable<StreamFnArgs[0]> extends never ? never : never;
  // The compile-time type for baseStreamFn requires a heavy import surface; cast
  // via unknown is the standard pattern in adjacent vitest files.
  const wrapper = createOpencodeGoKimiNoReasoningWrapper(
    baseStreamFn as unknown as Parameters<typeof createOpencodeGoKimiNoReasoningWrapper>[0],
  );
  return { wrapper, baseStreamFn, seen };
}

describe("createOpencodeGoKimiNoReasoningWrapper (#83812)", () => {
  it("strips reasoning_details on replayed assistant messages for kimi-k2.6", async () => {
    const payload: Record<string, unknown> = {
      model: "kimi-k2.6",
      reasoning: { effort: "medium" },
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "you are helpful" },
        {
          role: "assistant",
          content: "let me think",
          reasoning_details: [{ type: "reasoning.text", text: "internal" }],
          reasoning_content: "internal again",
          reasoning: "ditto",
          reasoning_text: "ditto2",
        },
        { role: "user", content: "ok" },
      ],
    };
    const { wrapper } = captureStrippedPayload(
      { provider: "opencode-go", id: "kimi-k2.6" },
      payload,
    );
    expect(wrapper).toBeDefined();
    await wrapper!({ provider: "opencode-go", id: "kimi-k2.6" } as never, {} as never, {} as never);

    expect(payload.reasoning).toBeUndefined();
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.messages).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "assistant", content: "let me think" },
      { role: "user", content: "ok" },
    ]);
  });

  it("walks array-shaped message content parts", async () => {
    const payload: Record<string, unknown> = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer", reasoning_details: [{ type: "x" }] },
            { type: "tool_use", reasoning: "inner" },
          ],
        },
      ],
    };
    const { wrapper } = captureStrippedPayload(
      { provider: "opencode-go", id: "kimi-k2.5" },
      payload,
    );
    await wrapper!({ provider: "opencode-go", id: "kimi-k2.5" } as never, {} as never, {} as never);
    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }, { type: "tool_use" }],
      },
    ]);
  });

  it("also strips per-message reasoning from input[] (Responses-style payload)", async () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          role: "assistant",
          reasoning_details: [{ type: "x" }],
          reasoning: "hidden",
        },
      ],
    };
    const { wrapper } = captureStrippedPayload(
      { provider: "opencode-go", id: "kimi-k2.6" },
      payload,
    );
    await wrapper!({ provider: "opencode-go", id: "kimi-k2.6" } as never, {} as never, {} as never);
    expect(payload.input).toEqual([{ role: "assistant" }]);
  });

  it("does not touch payloads for unrelated opencode-go models", async () => {
    const payload: Record<string, unknown> = {
      reasoning: "kept",
      messages: [{ role: "assistant", reasoning_details: [{ type: "x" }] }],
    };
    const { wrapper } = captureStrippedPayload(
      { provider: "opencode-go", id: "deepseek-v4-pro" },
      payload,
    );
    await wrapper!(
      { provider: "opencode-go", id: "deepseek-v4-pro" } as never,
      {} as never,
      {} as never,
    );
    // The wrapper short-circuits to underlying for non-Kimi IDs; nothing should be touched.
    expect(payload.reasoning).toBe("kept");
    expect(payload.messages).toEqual([{ role: "assistant", reasoning_details: [{ type: "x" }] }]);
  });
});
