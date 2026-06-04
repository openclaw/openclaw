// Fireworks tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createFireworksKimiThinkingDisabledWrapper,
  wrapFireworksProviderStream,
} from "./stream.js";

function capturePayload(params: {
  provider: string;
  api: string;
  modelId: string;
  initialPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload: Record<string, unknown> = { ...params.initialPayload };
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
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("forces thinking disabled for Fireworks Kimi k2.5 aliases", () => {
    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/routers/kimi-k2.5-turbo",
      }),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("forces thinking disabled for Fireworks Kimi k2.6 models", () => {
    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/models/kimi-k2p6",
      }),
    ).toEqual({ thinking: { type: "disabled" } });

    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/routers/kimi-k2.6-turbo",
      }),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("strips reasoning fields so dynamic Kimi models cannot re-enable visible CoT", () => {
    // kimi-k2p5 is not a manifest row, so its reasoning:false is not guaranteed
    // upstream; the wrapper must still drop any reasoning fields locally.
    for (const modelId of [
      "accounts/fireworks/models/kimi-k2p5",
      "accounts/fireworks/models/kimi-k2p6",
    ]) {
      expect(
        capturePayload({
          provider: "fireworks",
          api: "openai-completions",
          modelId,
          initialPayload: {
            reasoning_effort: "low",
            reasoning: { effort: "low" },
            reasoningEffort: "low",
          },
        }),
      ).toEqual({ thinking: { type: "disabled" } });
    }
  });

  it("passes the thinking-disabled payload to caller onPayload hooks", () => {
    let callbackPayload: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {};
      options?.onPayload?.(payload, _model);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createFireworksKimiThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "fireworks",
        id: "accounts/fireworks/routers/kimi-k2p5-turbo",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {
        onPayload: (payload) => {
          callbackPayload = payload as Record<string, unknown>;
        },
      },
    );

    expect(callbackPayload).toEqual({ thinking: { type: "disabled" } });
  });

  it("returns no provider wrapper for non-target Fireworks requests", () => {
    expect(
      wrapFireworksProviderStream({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        model: {
          api: "openai-completions",
          provider: "fireworks",
          id: "accounts/fireworks/models/qwen3.6-plus",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();

    expect(
      wrapFireworksProviderStream({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
        model: {
          api: "openai-responses",
          provider: "fireworks",
          id: "accounts/fireworks/routers/kimi-k2p5-turbo",
        } as Model<"openai-responses">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();

    expect(
      wrapFireworksProviderStream({
        provider: "fireworks-ai",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
        model: {
          api: "openai-completions",
          provider: "fireworks-ai",
          id: "accounts/fireworks/routers/kimi-k2p5-turbo",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");

    expect(
      wrapFireworksProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
