import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

async function createPayloadRunner() {
  const provider = await registerSingleProviderPlugin(plugin);
  return (
    modelId: string,
    payload: Record<string, unknown>,
    thinkingLevel?: "high",
    options: Parameters<StreamFn>[2] = {},
  ) => {
    let capturedPayload: Record<string, unknown> | undefined;
    const streamFn: StreamFn = (model, _context, streamOptions) => {
      streamOptions?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };
    const wrapped = provider.wrapStreamFn?.({
      provider: "kilocode",
      modelId,
      thinkingLevel,
      streamFn,
    } as never);
    void wrapped?.(
      {
        api: "openai-completions",
        provider: "kilocode",
        id: modelId,
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      options,
    );
    return capturedPayload;
  };
}

describe("kilocode provider plugin", () => {
  it("wires kilocode-thinking stream hooks", async () => {
    const run = await createPayloadRunner();
    const makePayload = () => ({ config: { thinkingConfig: { thinkingBudget: -1 } } });
    expect(run("openai/gpt-5.4", makePayload(), "high")).toEqual({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning: { effort: "high" },
    });
    expect(run("kilo-auto/balanced", makePayload(), "high")).not.toHaveProperty("reasoning");
  });

  it("normalizes string stop after caller payload hooks", async () => {
    const run = await createPayloadRunner();
    const result = run("deepseek/deepseek-v4-flash", {}, undefined, {
      onPayload: (payload) => {
        (payload as Record<string, unknown>).stop = "\n";
      },
    });
    expect(result?.stop).toEqual(["\n"]);
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
