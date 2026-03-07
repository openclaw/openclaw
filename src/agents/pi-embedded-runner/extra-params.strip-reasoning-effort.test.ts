import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

type ReasoningEffortCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-completions">;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  options?: SimpleStreamOptions;
};

function runReasoningEffortCase(params: ReasoningEffortCase) {
  const payload: Record<string, unknown> = {
    model: params.model.id,
    messages: [],
    reasoning_effort: "medium",
  };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, params.cfg, params.applyProvider, params.applyModelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, params.options ?? {});

  return payload;
}

describe("extra-params: strip reasoning_effort for unsupported providers", () => {
  it("strips reasoning_effort for custom providers", () => {
    const payload = runReasoningEffortCase({
      applyProvider: "custom-provider",
      applyModelId: "some-model",
      model: {
        api: "openai-completions",
        provider: "custom-provider",
        id: "some-model",
        reasoning: true,
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("strips reasoning_effort for moonshot provider", () => {
    const payload = runReasoningEffortCase({
      applyProvider: "moonshot",
      applyModelId: "k2-0411",
      model: {
        api: "openai-completions",
        provider: "moonshot",
        id: "k2-0411",
        reasoning: true,
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("preserves reasoning_effort for openai provider", () => {
    const payload = runReasoningEffortCase({
      applyProvider: "openai",
      applyModelId: "o3",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "o3",
        reasoning: true,
      } as Model<"openai-completions">,
    });

    expect(payload.reasoning_effort).toBe("medium");
  });

  it("preserves reasoning_effort for openai-codex provider", () => {
    const payload = runReasoningEffortCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-completions",
        provider: "openai-codex",
        id: "gpt-5.3-codex",
        reasoning: true,
      } as Model<"openai-completions">,
    });

    expect(payload.reasoning_effort).toBe("medium");
  });

  it("preserves reasoning_effort for azure-openai-responses provider", () => {
    const payload = runReasoningEffortCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "o3",
      model: {
        api: "openai-completions",
        provider: "azure-openai-responses",
        id: "o3",
        reasoning: true,
      } as Model<"openai-completions">,
    });

    expect(payload.reasoning_effort).toBe("medium");
  });

  it("strips reasoning_effort for siliconflow provider", () => {
    const payload = runReasoningEffortCase({
      applyProvider: "siliconflow",
      applyModelId: "Pro/deepseek-ai/DeepSeek-R1",
      model: {
        api: "openai-completions",
        provider: "siliconflow",
        id: "Pro/deepseek-ai/DeepSeek-R1",
        reasoning: true,
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
