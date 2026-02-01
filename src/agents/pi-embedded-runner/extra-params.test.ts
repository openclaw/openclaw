import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createThinkingDisabledWrapper } from "./extra-params.js";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text"],
    maxTokens: 4096,
    contextWindow: 200_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as Model<Api>;
}

describe("createThinkingDisabledWrapper", () => {
  it("injects thinking: disabled for anthropic-messages reasoning model", () => {
    const capturedPayloads: unknown[] = [];
    const baseFn: StreamFn = vi.fn((_model, _ctx, _options) => {
      return { push: vi.fn(), end: vi.fn() } as never;
    });

    const wrapped = createThinkingDisabledWrapper(baseFn, makeModel());
    void wrapped(
      makeModel(),
      { messages: [], tools: [] },
      {
        onPayload: (p) => capturedPayloads.push(p),
      },
    );

    expect(baseFn).toHaveBeenCalledOnce();

    const call = vi.mocked(baseFn).mock.calls[0];
    const optionsArg = call[2] as { onPayload?: (p: unknown) => void };
    const payload: Record<string, unknown> = { model: "test", max_tokens: 1024 };
    optionsArg.onPayload!(payload);

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(capturedPayloads).toHaveLength(1);
  });

  it("does not overwrite when thinking is already set", () => {
    const baseFn: StreamFn = vi.fn((_model, _ctx, _options) => {
      return { push: vi.fn(), end: vi.fn() } as never;
    });

    const wrapped = createThinkingDisabledWrapper(baseFn, makeModel());
    void wrapped(makeModel(), { messages: [], tools: [] }, {});

    const call = vi.mocked(baseFn).mock.calls[0];
    const optionsArg = call[2] as { onPayload?: (p: unknown) => void };
    const payload: Record<string, unknown> = {
      model: "test",
      thinking: { type: "enabled", budget_tokens: 1024 },
    };
    optionsArg.onPayload!(payload);

    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("does not overwrite explicit null thinking value", () => {
    const baseFn: StreamFn = vi.fn((_model, _ctx, _options) => {
      return { push: vi.fn(), end: vi.fn() } as never;
    });

    const wrapped = createThinkingDisabledWrapper(baseFn, makeModel());
    void wrapped(makeModel(), { messages: [], tools: [] }, {});

    const call = vi.mocked(baseFn).mock.calls[0];
    const optionsArg = call[2] as { onPayload?: (p: unknown) => void };
    const payload: Record<string, unknown> = { model: "test", thinking: null };
    optionsArg.onPayload!(payload);

    expect(payload.thinking).toBeNull();
  });

  it("returns base streamFn unchanged for non-reasoning model", () => {
    const baseFn: StreamFn = vi.fn();
    const result = createThinkingDisabledWrapper(baseFn, makeModel({ reasoning: false }));
    expect(result).toBe(baseFn);
  });

  it("returns base streamFn unchanged for non-anthropic API", () => {
    const baseFn: StreamFn = vi.fn();
    const result = createThinkingDisabledWrapper(
      baseFn,
      makeModel({ api: "openai-responses" as Api }),
    );
    expect(result).toBe(baseFn);
  });
});
