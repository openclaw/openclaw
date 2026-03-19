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

type BearerAuthCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"anthropic-messages">;
  cfg: Parameters<typeof applyExtraParamsToAgent>[1];
  callOptions?: SimpleStreamOptions;
};

function runBearerAuthCase(params: BearerAuthCase): {
  capturedOptions: SimpleStreamOptions | undefined;
} {
  let capturedOptions: SimpleStreamOptions | undefined;

  const baseStreamFn: StreamFn = (_model, _context, options) => {
    capturedOptions = options;
    return {} as ReturnType<StreamFn>;
  };

  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(agent, params.cfg, params.applyProvider, params.applyModelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, params.callOptions ?? { apiKey: "sk-minimax-test" });

  return { capturedOptions };
}

const minimaxModel: Model<"anthropic-messages"> = {
  api: "anthropic-messages",
  provider: "minimax",
  id: "MiniMax-M2.5",
  name: "MiniMax M2.5",
  baseUrl: "https://api.minimax.io/anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const minimaxCfg: Parameters<typeof applyExtraParamsToAgent>[1] = {
  models: {
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        authHeader: true,
        models: [],
      },
    },
  },
};

describe("extra-params: Bearer auth wrapper (authHeader: true)", () => {
  it("injects Authorization: Bearer header and removes apiKey for authHeader providers", () => {
    const { capturedOptions } = runBearerAuthCase({
      applyProvider: "minimax",
      applyModelId: "MiniMax-M2.5",
      model: minimaxModel,
      cfg: minimaxCfg,
      callOptions: { apiKey: "sk-minimax-test" },
    });

    expect(capturedOptions?.apiKey).toBeUndefined();
    expect((capturedOptions?.headers as Record<string, unknown>)?.["Authorization"]).toBe(
      "Bearer sk-minimax-test",
    );
    // X-Api-Key should be set to null to explicitly remove it from the Anthropic SDK
    expect((capturedOptions?.headers as Record<string, unknown>)?.["X-Api-Key"]).toBeNull();
    // anthropic-beta should be suppressed: MiniMax doesn't support fine-grained-tool-streaming
    // etc. and sending them causes single-chunk responses instead of token-by-token streaming
    expect((capturedOptions?.headers as Record<string, unknown>)?.["anthropic-beta"]).toBeNull();
  });

  it("passes through unchanged when no apiKey is present", () => {
    const { capturedOptions } = runBearerAuthCase({
      applyProvider: "minimax",
      applyModelId: "MiniMax-M2.5",
      model: minimaxModel,
      cfg: minimaxCfg,
      callOptions: {},
    });

    expect(
      (capturedOptions?.headers as Record<string, unknown>)?.["Authorization"],
    ).toBeUndefined();
  });

  it("does not apply Bearer auth wrapper for providers without authHeader", () => {
    const { capturedOptions } = runBearerAuthCase({
      applyProvider: "anthropic",
      applyModelId: "claude-opus-4-5",
      model: {
        ...minimaxModel,
        id: "claude-opus-4-5",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      },
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [],
            },
          },
        },
      },
      callOptions: { apiKey: "sk-ant-test" },
    });

    // apiKey should be preserved, Authorization header should not be injected
    expect(capturedOptions?.apiKey).toBe("sk-ant-test");
    expect(
      (capturedOptions?.headers as Record<string, unknown>)?.["Authorization"],
    ).toBeUndefined();
  });

  it("preserves existing headers alongside injected Authorization header", () => {
    const { capturedOptions } = runBearerAuthCase({
      applyProvider: "minimax",
      applyModelId: "MiniMax-M2.5",
      model: minimaxModel,
      cfg: minimaxCfg,
      callOptions: {
        apiKey: "sk-minimax-test",
        headers: { "X-Custom": "custom-value" },
      },
    });

    expect(capturedOptions?.apiKey).toBeUndefined();
    expect((capturedOptions?.headers as Record<string, unknown>)?.["X-Custom"]).toBe(
      "custom-value",
    );
    expect((capturedOptions?.headers as Record<string, unknown>)?.["Authorization"]).toBe(
      "Bearer sk-minimax-test",
    );
  });
});
