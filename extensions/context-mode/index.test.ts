import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function createMockApi(
  overrides: Partial<OpenClawPluginApi> & { pluginConfig?: Record<string, unknown> } = {},
): OpenClawPluginApi {
  return {
    id: "context-mode",
    name: "Context Mode",
    description: "test",
    source: "test",
    config: {} as never,
    pluginConfig: overrides.pluginConfig,
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (input: string) => input,
    on: vi.fn(),
    ...overrides,
  };
}

describe("context-mode plugin registration", () => {
  it("logs disabled message when not enabled", () => {
    const api = createMockApi();
    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    expect(api.on).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it("registers hook and tools when enabled", () => {
    const api = createMockApi({
      pluginConfig: { enabled: true },
    });
    plugin.register(api);

    // Should register tool_result_persist + before_prompt_build hooks
    expect(api.on).toHaveBeenCalledTimes(2);
    expect(api.on).toHaveBeenCalledWith("tool_result_persist", expect.any(Function), {
      priority: 10,
    });
    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    // Should register context_search, context_retrieve, and context_list tools
    expect(api.registerTool).toHaveBeenCalledTimes(3);
  });

  it("respects custom threshold config", () => {
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 5000 },
    });
    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("threshold: 5000"));
  });

  it("respects excludeTools config", () => {
    const api = createMockApi({
      pluginConfig: { enabled: true, excludeTools: ["bash", "read_file"] },
    });
    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("bash, read_file"));
  });
});

describe("tool_result_persist hook", () => {
  it("passes through small results unchanged", () => {
    const on = vi.fn();
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 2000 },
      on,
    });
    plugin.register(api);

    const handler = on.mock.calls[0]?.[1];
    expect(handler).toBeDefined();

    const smallMessage = {
      role: "toolResult",
      content: [{ type: "text", text: "small result" }],
    };

    const result = handler(
      { toolName: "test", toolCallId: "c1", message: smallMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "test", toolCallId: "c1" },
    );

    // Should return undefined (no modification)
    expect(result).toBeUndefined();
  });

  it("compresses large results", () => {
    const on = vi.fn();
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 100 },
      on,
    });
    plugin.register(api);

    const handler = on.mock.calls[0]?.[1];
    const largeText = "x".repeat(5000);
    const largeMessage = {
      role: "toolResult",
      content: [{ type: "text", text: largeText }],
    };

    const result = handler(
      { toolName: "test", toolCallId: "c1", message: largeMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "test", toolCallId: "c1" },
    );

    expect(result).toBeDefined();
    expect(result.message).toBeDefined();

    const newContent = result.message.content;
    expect(Array.isArray(newContent)).toBe(true);
    const textBlock = newContent.find((b: { type: string }) => b.type === "text");
    expect(textBlock.text).toContain("Context Mode: compressed");
    expect(textBlock.text).toContain("context_retrieve");
    expect(textBlock.text.length).toBeLessThan(largeText.length);
  });

  it("skips excluded tools", () => {
    const on = vi.fn();
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 100, excludeTools: ["bash"] },
      on,
    });
    plugin.register(api);

    const handler = on.mock.calls[0]?.[1];
    const largeMessage = {
      role: "toolResult",
      content: [{ type: "text", text: "x".repeat(5000) }],
    };

    const result = handler(
      { toolName: "bash", toolCallId: "c1", message: largeMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "bash", toolCallId: "c1" },
    );

    expect(result).toBeUndefined();
  });

  it("skips synthetic results", () => {
    const on = vi.fn();
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 100 },
      on,
    });
    plugin.register(api);

    const handler = on.mock.calls[0]?.[1];
    const largeMessage = {
      role: "toolResult",
      content: [{ type: "text", text: "x".repeat(5000) }],
    };

    const result = handler(
      { toolName: "test", toolCallId: "c1", message: largeMessage, isSynthetic: true },
      { agentId: "a1", sessionKey: "s1", toolName: "test", toolCallId: "c1" },
    );

    expect(result).toBeUndefined();
  });

  it("skips non-toolResult messages", () => {
    const on = vi.fn();
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 100 },
      on,
    });
    plugin.register(api);

    const handler = on.mock.calls[0]?.[1];
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "x".repeat(5000) }],
    };

    const result = handler(
      { toolName: "test", toolCallId: "c1", message: userMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "test", toolCallId: "c1" },
    );

    expect(result).toBeUndefined();
  });

  it("skips own tools (context_search, context_retrieve, context_list)", () => {
    const on = vi.fn();
    const api = createMockApi({
      pluginConfig: { enabled: true, threshold: 100 },
      on,
    });
    plugin.register(api);

    const handler = on.mock.calls[0]?.[1];
    const largeMessage = {
      role: "toolResult",
      content: [{ type: "text", text: "x".repeat(5000) }],
    };

    const result1 = handler(
      { toolName: "context_search", toolCallId: "c1", message: largeMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "context_search", toolCallId: "c1" },
    );
    expect(result1).toBeUndefined();

    const result2 = handler(
      { toolName: "context_retrieve", toolCallId: "c2", message: largeMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "context_retrieve", toolCallId: "c2" },
    );
    expect(result2).toBeUndefined();

    const result3 = handler(
      { toolName: "context_list", toolCallId: "c3", message: largeMessage },
      { agentId: "a1", sessionKey: "s1", toolName: "context_list", toolCallId: "c3" },
    );
    expect(result3).toBeUndefined();
  });
});
