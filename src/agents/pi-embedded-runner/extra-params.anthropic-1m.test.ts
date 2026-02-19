import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

function createModel(id: string): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function captureStreamCall(
  provider: string,
  modelId: string,
  extraParams?: Record<string, unknown>,
) {
  let capturedModel: Model<"anthropic-messages"> | undefined;
  let capturedHeaders: Record<string, string> | undefined;

  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedModel = model as Model<"anthropic-messages">;
    capturedHeaders = options?.headers;
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, provider, modelId, extraParams);

  const model = createModel(modelId);
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, {});

  return { capturedModel, capturedHeaders };
}

describe("extra-params: Anthropic 1M model ID handling", () => {
  it("strips -1m suffix from model ID before sending to API", () => {
    const { capturedModel } = captureStreamCall("anthropic", "claude-opus-4-6-1m", {
      context1m: true,
    });
    expect(capturedModel?.id).toBe("claude-opus-4-6");
  });

  it("strips -1m suffix case-insensitively", () => {
    const { capturedModel } = captureStreamCall("anthropic", "claude-sonnet-4-6-1M", {
      context1m: true,
    });
    expect(capturedModel?.id).toBe("claude-sonnet-4-6");
  });

  it("auto-injects context-1m beta header when model ID ends with -1m", () => {
    const { capturedHeaders } = captureStreamCall("anthropic", "claude-opus-4-6-1m");
    expect(capturedHeaders?.["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });

  it("does not strip suffix for non-anthropic providers", () => {
    const { capturedModel } = captureStreamCall("openrouter", "claude-opus-4-6-1m");
    expect(capturedModel?.id).toBe("claude-opus-4-6-1m");
  });

  it("preserves model ID when no -1m suffix", () => {
    const { capturedModel } = captureStreamCall("anthropic", "claude-opus-4-6", {
      context1m: true,
    });
    expect(capturedModel?.id).toBe("claude-opus-4-6");
  });

  it("injects beta header with explicit context1m param (no suffix)", () => {
    const { capturedHeaders } = captureStreamCall("anthropic", "claude-opus-4-6", {
      context1m: true,
    });
    expect(capturedHeaders?.["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });
});
