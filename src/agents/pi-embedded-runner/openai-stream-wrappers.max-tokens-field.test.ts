import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createOpenAICompatMaxTokensFieldWrapper } from "./openai-stream-wrappers.js";

function runCase(params: {
  model: Model<"openai-completions"> | Model<"openai-responses">;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(params.payload, model);
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenAICompatMaxTokensFieldWrapper(baseStreamFn);
  const context: Context = { messages: [] };
  void wrapped(params.model, context, {});
  return params.payload;
}

describe("createOpenAICompatMaxTokensFieldWrapper", () => {
  it("maps max_completion_tokens to max_tokens when compat requires max_tokens", () => {
    const payload = runCase({
      model: {
        api: "openai-completions",
        provider: "mistral",
        id: "mistral-small-latest",
        compat: { maxTokensField: "max_tokens" },
      } as Model<"openai-completions">,
      payload: { max_completion_tokens: 8192, temperature: 0.2 },
    });

    expect(payload.max_tokens).toBe(8192);
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload.temperature).toBe(0.2);
  });

  it("maps max_tokens to max_completion_tokens when compat requires max_completion_tokens", () => {
    const payload = runCase({
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-4.1",
        compat: { maxTokensField: "max_completion_tokens" },
      } as Model<"openai-completions">,
      payload: { max_tokens: 4096 },
    });

    expect(payload.max_completion_tokens).toBe(4096);
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("does nothing for non-openai-completions APIs", () => {
    const payload = runCase({
      model: {
        api: "openai-responses",
        provider: "mistral",
        id: "mistral-small-latest",
        compat: { maxTokensField: "max_tokens" },
      } as unknown as Model<"openai-responses">,
      payload: { max_completion_tokens: 2048 },
    });

    expect(payload.max_completion_tokens).toBe(2048);
    expect(payload).not.toHaveProperty("max_tokens");
  });
});
