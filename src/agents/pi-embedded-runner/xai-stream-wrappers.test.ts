import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createXaiFastModeWrapper } from "./xai-stream-wrappers.js";

function captureWrappedModelId(params: { modelId: string; fastMode: boolean }): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createXaiFastModeWrapper(baseStreamFn, params.fastMode);
  void wrapped(
    {
      api: "openai-completions",
      provider: "xai",
      id: params.modelId,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    {},
  );

  return capturedModelId;
}

describe("xai fast mode wrapper", () => {
  it("rewrites Grok 3 models to fast variants", () => {
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: true })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3-mini", fastMode: true })).toBe(
      "grok-3-mini-fast",
    );
  });

  it("leaves unsupported or disabled models unchanged", () => {
    expect(captureWrappedModelId({ modelId: "grok-3-fast", fastMode: true })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: false })).toBe("grok-3");
  });
});
