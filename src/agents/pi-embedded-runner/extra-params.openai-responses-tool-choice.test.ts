import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
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
  payload: Record<string, unknown>;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  options?: SimpleStreamOptions;
};

function runToolChoiceCase(params: ToolChoiceCase) {
  const payload = params.payload;
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

describe("extra-params: openai-responses tool_choice default injection", () => {
  it("injects tool_choice='auto' when tools present and tool_choice is null", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [{ type: "function", function: { name: "exec" } }],
        tool_choice: null,
      },
    });

    expect(payload.tool_choice).toBe("auto");
  });

  it("injects tool_choice='auto' when tools present and tool_choice is undefined", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [{ type: "function", function: { name: "browser" } }],
      },
    });

    expect(payload.tool_choice).toBe("auto");
  });

  it("does not override explicit tool_choice='required'", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [{ type: "function", function: { name: "exec" } }],
        tool_choice: "required",
      },
    });

    expect(payload.tool_choice).toBe("required");
  });

  it("does not override explicit tool_choice='none'", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [{ type: "function", function: { name: "exec" } }],
        tool_choice: "none",
      },
    });

    expect(payload.tool_choice).toBe("none");
  });

  it("does not override explicit tool_choice object", () => {
    const toolChoiceObj = { type: "function", function: { name: "exec" } };
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [{ type: "function", function: { name: "exec" } }],
        tool_choice: toolChoiceObj,
      },
    });

    expect(payload.tool_choice).toBe(toolChoiceObj);
  });

  it("does not inject tool_choice when tools array is empty", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [],
        tool_choice: null,
      },
    });

    expect(payload.tool_choice).toBeNull();
  });

  it("does not inject tool_choice when tools is absent", () => {
    const payload = runToolChoiceCase({
      applyProvider: "custom-sub2api",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "custom-sub2api",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
      },
    });

    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("does not inject tool_choice for non-openai-responses API models", () => {
    const payload: Record<string, unknown> = {
      model: "gpt-5",
      tools: [{ type: "function", function: { name: "exec" } }],
      tool_choice: null,
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-completions",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payload.tool_choice).toBeNull();
  });

  it("works with azure-openai-responses provider", () => {
    const payload = runToolChoiceCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-5.3-codex",
      model: {
        api: "openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex",
      } as Model<"openai-responses">,
      payload: {
        model: "gpt-5.3-codex",
        tools: [{ type: "function", function: { name: "exec" } }],
        tool_choice: null,
      },
    });

    expect(payload.tool_choice).toBe("auto");
  });

  it("preserves existing onPayload callback chain", () => {
    const outerPayloadSpy = vi.fn();
    const payload: Record<string, unknown> = {
      model: "gpt-5.3-codex",
      tools: [{ type: "function", function: { name: "exec" } }],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "custom-sub2api", "gpt-5.3-codex");

    const model = {
      api: "openai-responses",
      provider: "custom-sub2api",
      id: "gpt-5.3-codex",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { onPayload: outerPayloadSpy });

    expect(payload.tool_choice).toBe("auto");
    expect(outerPayloadSpy).toHaveBeenCalledWith(payload);
  });
});
