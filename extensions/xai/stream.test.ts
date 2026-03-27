import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createXaiFastModeWrapper, createXaiToolPayloadCompatibilityWrapper } from "./stream.js";

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean;
  api?: Extract<Api, "openai-completions" | "openai-responses">;
}): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createXaiFastModeWrapper(baseStreamFn, params.fastMode);
  void wrapped(
    {
      api: params.api ?? "openai-responses",
      provider: "xai",
      id: params.modelId,
    } as Model<Extract<Api, "openai-completions" | "openai-responses">>,
    { messages: [] } as Context,
    {},
  );

  return capturedModelId;
}

describe("xai stream wrappers", () => {
  it("rewrites supported Grok models to fast variants when fast mode is enabled", () => {
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: true })).toBe("grok-3-fast");
    expect(
      captureWrappedModelId({
        modelId: "grok-3",
        fastMode: true,
        api: "openai-completions",
      }),
    ).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-4", fastMode: true })).toBe("grok-4-fast");
  });

  it("leaves unsupported or disabled models unchanged", () => {
    expect(captureWrappedModelId({ modelId: "grok-3-fast", fastMode: true })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: false })).toBe("grok-3");
  });

  it("strips unsupported strict and reasoning controls from tool payloads", () => {
    const payload = {
      reasoning: "high",
      reasoningEffort: "high",
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-completions">);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tools[0]?.function).not.toHaveProperty("strict");
  });
});
