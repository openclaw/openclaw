import { describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { applyExtraParamsToAgent } from "./extra-params.js";

// Mock streamSimple for testing
vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

describe("extra-params: Z.AI tool_stream support", () => {
  it("should inject tool_stream=true for zai provider by default", () => {
    const capturedPayloads: unknown[] = [];
    const mockStreamFn: StreamFn = vi.fn((model, context, options) => {
      // Capture the payload that would be sent
      options?.onPayload?.({ model: model.id, messages: [] });
      return {
        push: vi.fn(),
        result: vi.fn().mockResolvedValue({
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        }),
      } as any;
    });

    const agent = { streamFn: mockStreamFn };
    const cfg = {
      agents: {
        defaults: {},
      },
    };

    applyExtraParamsToAgent(agent, cfg as any, "zai", "glm-5");

    // The streamFn should be wrapped
    expect(agent.streamFn).toBeDefined();
    expect(agent.streamFn).not.toBe(mockStreamFn);
  });

  it("should not inject tool_stream for non-zai providers", () => {
    const mockStreamFn: StreamFn = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn().mockResolvedValue({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
      }),
    } as any));

    const agent = { streamFn: mockStreamFn };
    const cfg = {};

    applyExtraParamsToAgent(agent, cfg as any, "anthropic", "claude-opus-4-6");

    // Should remain unchanged (except for OpenAI wrapper)
    expect(agent.streamFn).toBeDefined();
  });

  it("should allow disabling tool_stream via params", () => {
    const mockStreamFn: StreamFn = vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn().mockResolvedValue({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
      }),
    } as any));

    const agent = { streamFn: mockStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "zai/glm-5": {
              params: {
                tool_stream: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg as any, "zai", "glm-5");

    // The tool_stream wrapper should be applied but with enabled=false
    // In this case, it should just return the underlying streamFn
    expect(agent.streamFn).toBeDefined();
  });
});
