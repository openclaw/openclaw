// Kilocode tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("kilocode provider plugin", () => {
  it("wires kilocode-thinking stream hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const wrappedReasoning = provider.wrapStreamFn?.({
      provider: "kilocode",
      modelId: "openai/gpt-5.4",
      thinkingLevel: "high",
      streamFn: baseStreamFn,
    } as never);

    void wrappedReasoning?.(
      {
        api: "openai-completions",
        provider: "kilocode",
        id: "openai/gpt-5.4",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toEqual({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning: { effort: "high" },
    });

    const wrappedAuto = provider.wrapStreamFn?.({
      provider: "kilocode",
      modelId: "kilo-auto/balanced",
      thinkingLevel: "high",
      streamFn: baseStreamFn,
    } as never);

    void wrappedAuto?.(
      {
        api: "openai-completions",
        provider: "kilocode",
        id: "kilo-auto/balanced",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).not.toHaveProperty("reasoning");
  });

  it("normalizes string stop after caller payload hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload as never, model as never);
      payloads.push(payload);
      return {} as never;
    };

    const wrapped = provider.wrapStreamFn?.({
      provider: "kilocode",
      modelId: "deepseek/deepseek-v4-flash",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "kilocode",
        id: "deepseek/deepseek-v4-flash",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {
        onPayload: (payload) => {
          (payload as Record<string, unknown>).stop = "\n";
        },
      },
    );

    expect(payloads[0]?.stop).toEqual(["\n"]);
  });

  it("publishes configured Kilo models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              kilocode: {
                models: [
                  {
                    id: "google/gemini-3-pro-preview",
                    name: "Gemini 3 Pro Preview",
                    input: ["text", "image"],
                    reasoning: true,
                    contextWindow: 1048576,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "kilocode",
        id: "google/gemini-3.1-pro-preview",
        name: "Gemini 3 Pro Preview",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1048576,
      },
    ]);
  });
});
