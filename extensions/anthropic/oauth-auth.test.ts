import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

describe("Anthropic OAuth authentication", () => {
  it("should use Bearer auth for OAuth tokens (sk-ant-oat-)", async () => {
    const mockStreamFn: StreamFn = vi.fn((model, context, options) => {
      return Promise.resolve({} as never);
    });

    const { default: anthropicPlugin } = await import("./index.js");

    let wrapStreamFn: ((ctx: { streamFn: StreamFn }) => StreamFn) | undefined;

    const mockApi = {
      registerProvider: vi.fn((config) => {
        wrapStreamFn = config.wrapStreamFn;
      }),
      registerMediaUnderstandingProvider: vi.fn(),
      registerCliBackend: vi.fn(),
    };

    anthropicPlugin.register(mockApi as never);

    expect(wrapStreamFn).toBeDefined();

    const wrappedStreamFn = wrapStreamFn!({ streamFn: mockStreamFn });

    const oauthToken = "sk-ant-oat-test-token-1234567890";
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    };
    const context = { messages: [] };
    const options = { apiKey: oauthToken };

    await wrappedStreamFn(model as never, context as never, options as never);

    expect(mockStreamFn).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${oauthToken}`,
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("should NOT modify headers for standard API keys (sk-ant-api-)", async () => {
    const mockStreamFn: StreamFn = vi.fn((model, context, options) => {
      return Promise.resolve({} as never);
    });

    const { default: anthropicPlugin } = await import("./index.js");

    let wrapStreamFn: ((ctx: { streamFn: StreamFn }) => StreamFn) | undefined;

    const mockApi = {
      registerProvider: vi.fn((config) => {
        wrapStreamFn = config.wrapStreamFn;
      }),
      registerMediaUnderstandingProvider: vi.fn(),
      registerCliBackend: vi.fn(),
    };

    anthropicPlugin.register(mockApi as never);

    expect(wrapStreamFn).toBeDefined();

    const wrappedStreamFn = wrapStreamFn!({ streamFn: mockStreamFn });

    const apiKey = "sk-ant-api03-standard-key-1234567890";
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    };
    const context = { messages: [] };
    const options = { apiKey };

    await wrappedStreamFn(model as never, context as never, options as never);

    expect(mockStreamFn).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        apiKey,
      }),
    );
  });

  it("should preserve existing headers when using OAuth tokens", async () => {
    const mockStreamFn: StreamFn = vi.fn((model, context, options) => {
      return Promise.resolve({} as never);
    });

    const { default: anthropicPlugin } = await import("./index.js");

    let wrapStreamFn: ((ctx: { streamFn: StreamFn }) => StreamFn) | undefined;

    const mockApi = {
      registerProvider: vi.fn((config) => {
        wrapStreamFn = config.wrapStreamFn;
      }),
      registerMediaUnderstandingProvider: vi.fn(),
      registerCliBackend: vi.fn(),
    };

    anthropicPlugin.register(mockApi as never);

    expect(wrapStreamFn).toBeDefined();

    const wrappedStreamFn = wrapStreamFn!({ streamFn: mockStreamFn });

    const oauthToken = "sk-ant-oat-test-token-1234567890";
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    };
    const context = { messages: [] };
    const existingHeaders = { "x-custom-header": "custom-value" };
    const options = { apiKey: oauthToken, headers: existingHeaders };

    await wrappedStreamFn(model as never, context as never, options as never);

    expect(mockStreamFn).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${oauthToken}`,
          "anthropic-version": "2023-06-01",
          "x-custom-header": "custom-value",
        }),
      }),
    );
  });
});
