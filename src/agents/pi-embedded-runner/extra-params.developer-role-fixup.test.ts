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

type TestCase = {
  provider: string;
  modelId: string;
  model: Model<"openai-completions">;
  messages: Array<Record<string, unknown>>;
};

function runCase(params: TestCase) {
  const payload: Record<string, unknown> = {
    model: params.model.id,
    messages: params.messages,
  };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.provider, params.modelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {} as SimpleStreamOptions);

  return payload;
}

describe("extra-params: developer role fixup", () => {
  it("rewrites developer → system for non-OpenAI providers", () => {
    const payload = runCase({
      provider: "custom",
      modelId: "qwen-3.5",
      model: {
        api: "openai-completions",
        provider: "custom",
        id: "qwen-3.5",
      } as Model<"openai-completions">,
      messages: [
        { role: "developer", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    });

    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });

  it("preserves developer role for openai provider", () => {
    const payload = runCase({
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-completions">,
      messages: [
        { role: "developer", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    });

    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe("developer");
  });

  it("preserves developer role for openai-codex provider", () => {
    const payload = runCase({
      provider: "openai-codex",
      modelId: "codex-mini",
      model: {
        api: "openai-completions",
        provider: "openai-codex",
        id: "codex-mini",
      } as Model<"openai-completions">,
      messages: [
        { role: "developer", content: "System prompt" },
      ],
    });

    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe("developer");
  });

  it("does not touch non-developer roles", () => {
    const payload = runCase({
      provider: "custom",
      modelId: "llama-4",
      model: {
        api: "openai-completions",
        provider: "custom",
        id: "llama-4",
      } as Model<"openai-completions">,
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    });

    const msgs = payload.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[2].role).toBe("assistant");
  });
});
