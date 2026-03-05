import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

// Mock streamSimple for testing
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
  initialPayload?: Record<string, unknown>;
};

function runToolChoiceCase(params: ToolChoiceCase) {
  const payload: Record<string, unknown> = {
    model: params.model.id,
    ...params.initialPayload,
  };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.applyProvider, params.applyModelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {});

  return payload;
}

describe("extra-params: openai-responses tool_choice injection (#36057)", () => {
  it("injects tool_choice=auto for custom openai-responses provider when tools present and tool_choice absent", () => {
    const payload = runToolChoiceCase({
      applyProvider: "sub2api-gpt",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "sub2api-gpt",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", name: "exec" }],
      },
    });

    expect(payload.tool_choice).toBe("auto");
  });

  it("does not inject tool_choice when tools array is empty", () => {
    const payload = runToolChoiceCase({
      applyProvider: "sub2api-gpt",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "sub2api-gpt",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: { tools: [] },
    });

    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("does not inject tool_choice when tools are absent", () => {
    const payload = runToolChoiceCase({
      applyProvider: "sub2api-gpt",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "sub2api-gpt",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {},
    });

    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("preserves explicit tool_choice when already set", () => {
    const payload = runToolChoiceCase({
      applyProvider: "sub2api-gpt",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "sub2api-gpt",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", name: "exec" }],
        tool_choice: "required",
      },
    });

    expect(payload.tool_choice).toBe("required");
  });

  it("does not inject tool_choice for non-openai-responses api", () => {
    const payload = runToolChoiceCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
      } as unknown as Model<"openai-responses">,
      initialPayload: {
        tools: [{ type: "function", name: "exec" }],
      },
    });

    expect(payload).not.toHaveProperty("tool_choice");
  });
});
