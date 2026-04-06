import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing as extraParamsTesting } from "./pi-embedded-runner/extra-params.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner/extra-params.js";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "./pi-embedded-runner/proxy-stream-wrappers.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    wrapProviderStreamFn: (params) => {
      if (params.provider !== "openrouter") {
        return params.context.streamFn;
      }

      const providerRouting =
        params.context.extraParams?.provider != null &&
        typeof params.context.extraParams.provider === "object"
          ? (params.context.extraParams.provider as Record<string, unknown>)
          : undefined;
      let streamFn = params.context.streamFn;
      if (providerRouting) {
        const underlying = streamFn;
        streamFn = (model, context, options) =>
          (underlying as StreamFn)(
            {
              ...model,
              compat: { ...model.compat, openRouterRouting: providerRouting },
            },
            context,
            options,
          );
      }

      const skipReasoningInjection =
        params.context.modelId === "auto" || isProxyReasoningUnsupported(params.context.modelId);
      const thinkingLevel = skipReasoningInjection ? undefined : params.context.thinkingLevel;
      return createOpenRouterSystemCacheWrapper(createOpenRouterWrapper(streamFn, thinkingLevel));
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent OpenRouter reasoning", () => {
  function runPayloadCase(params: {
    modelId: string;
    thinkingLevel?: "off" | "low" | "medium" | "high";
    payload?: Record<string, unknown>;
  }) {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { ...params.payload };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openrouter",
      params.modelId,
      undefined,
      params.thinkingLevel,
    );

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: params.modelId,
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    return payloads[0] ?? {};
  }

  it("does not inject reasoning when thinkingLevel is off (default) for OpenRouter", () => {
    const payload = runPayloadCase({
      modelId: "deepseek/deepseek-r1",
      thinkingLevel: "off",
      payload: { model: "deepseek/deepseek-r1" },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("injects reasoning.effort when thinkingLevel is non-off for OpenRouter", () => {
    const payload = runPayloadCase({
      modelId: "openrouter/auto",
      thinkingLevel: "low",
    });

    expect(payload.reasoning).toEqual({ effort: "low" });
  });

  it("removes legacy reasoning_effort and keeps reasoning unset when thinkingLevel is off", () => {
    const payload = runPayloadCase({
      modelId: "openrouter/auto",
      thinkingLevel: "off",
      payload: { reasoning_effort: "high" },
    });

    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("does not inject effort when payload already has reasoning.max_tokens", () => {
    const payload = runPayloadCase({
      modelId: "openrouter/auto",
      thinkingLevel: "low",
      payload: { reasoning: { max_tokens: 256 } },
    });

    expect(payload).toEqual({ reasoning: { max_tokens: 256 } });
  });

  it("does not inject reasoning.effort for x-ai/grok models on OpenRouter (#32039)", () => {
    const payload = runPayloadCase({
      modelId: "x-ai/grok-4.1-fast",
      thinkingLevel: "medium",
      payload: { reasoning_effort: "medium" },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
