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

function buildAgent(apiKey?: string) {
  let capturedOptions: SimpleStreamOptions | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    capturedOptions = options;
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };
  return {
    agent,
    call(provider: string, modelId: string) {
      applyExtraParamsToAgent(agent, undefined, provider, modelId);
      const model = {
        api: "openai-completions",
        provider,
        id: modelId,
      } as Model<"openai-completions">;
      const context: Context = { messages: [] };
      void agent.streamFn?.(model, context, { apiKey });
      return capturedOptions;
    },
  };
}

describe("extra-params: fal OpenRouter Authorization header", () => {
  it("rewrites Authorization to Key format for fal-openrouter", () => {
    const helper = buildAgent("fal-test-key-123");
    const opts = helper.call("fal-openrouter", "google/gemini-2.5-flash");
    expect(opts?.headers).toMatchObject({
      Authorization: "Key fal-test-key-123",
    });
  });

  it("does not inject Key header for regular openrouter", () => {
    const helper = buildAgent("or-test-key");
    const opts = helper.call("openrouter", "google/gemini-2.5-flash");
    expect(opts?.headers?.Authorization).toBeUndefined();
  });

  it("omits Authorization header when no apiKey is provided", () => {
    const helper = buildAgent(undefined);
    const opts = helper.call("fal-openrouter", "google/gemini-2.5-flash");
    expect(opts?.headers?.Authorization).toBeUndefined();
  });
});
