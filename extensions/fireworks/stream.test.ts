import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createFireworksKimiThinkingDisabledWrapper } from "./stream.js";

function capturePayload(params: {
  provider: string;
  api: string;
  modelId: string;
  initialPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createFireworksKimiThinkingDisabledWrapper(baseStreamFn);
  void wrapped(
    {
      api: params.api,
      provider: params.provider,
      id: params.modelId,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    {},
  );

  return captured;
}

describe("createFireworksKimiThinkingDisabledWrapper", () => {
  it("forces thinking disabled for Fireworks Kimi models", () => {
    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
      }),
    ).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("strips reasoning fields when disabling Fireworks Kimi thinking", () => {
    const payload = capturePayload({
      provider: "fireworks",
      api: "openai-completions",
      modelId: "accounts/fireworks/models/kimi-k2p5",
      initialPayload: {
        reasoning_effort: "low",
        reasoning: { effort: "low" },
        reasoningEffort: "low",
      },
    });

    expect(payload).toEqual({ thinking: { type: "disabled" } });
  });

  it("does not affect non-Kimi Fireworks models", () => {
    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toEqual({});
  });

  it("does not affect non-Fireworks providers", () => {
    expect(
      capturePayload({
        provider: "openai",
        api: "openai-completions",
        modelId: "gpt-5.4",
      }),
    ).toEqual({});
  });
});
