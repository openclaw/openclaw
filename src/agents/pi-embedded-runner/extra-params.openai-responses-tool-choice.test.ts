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

type ToolChoiceCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-responses">;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  options?: SimpleStreamOptions;
  initialPayload?: Record<string, unknown>;
};

function runToolChoiceCase(params: ToolChoiceCase) {
  const payload: Record<string, unknown> = {
    model: params.model.id,
    messages: [],
    ...params.initialPayload,
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

describe("extra-params: OpenAI Responses tool_choice default", () => {
  it("injects tool_choice=auto when tools present but tool_choice missing", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-provider",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-provider",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", function: { name: "exec" } }],
      },
    });

    expect(payload.tool_choice).toBe("auto");
  });

  it("does not inject tool_choice when tools array is empty", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-provider",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-provider",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [],
      },
    });

    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("preserves explicit tool_choice when already set", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-provider",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-provider",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", function: { name: "exec" } }],
        tool_choice: "required",
      },
    });

    expect(payload.tool_choice).toBe("required");
  });

  it("does not inject tool_choice for non-openai-responses API", () => {
    const payload = runToolChoiceCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", function: { name: "exec" } }],
      },
    });

    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("injects tool_choice=auto for direct openai provider with responses API", () => {
    const payload = runToolChoiceCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", function: { name: "browser" } }],
      },
    });

    expect(payload.tool_choice).toBe("auto");
  });
});
