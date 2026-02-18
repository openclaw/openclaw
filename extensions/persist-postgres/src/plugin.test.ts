/**
 * Unit tests for persist-postgres plugin lifecycle.
 *
 * These tests verify plugin registration, configuration validation,
 * and error handling without requiring a running PostgreSQL instance.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { extractTextFromChatContent, stripEnvelope } from "../../../src/plugin-sdk/index.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

function createMockApi(
  overrides: Partial<{
    pluginConfig: Record<string, unknown>;
    env: Record<string, string | undefined>;
  }> = {},
): OpenClawPluginApi & { _hooks: Array<{ name: string; handler: Function; opts: unknown }> } {
  const hooks: Array<{ name: string; handler: Function; opts: unknown }> = [];
  return {
    _hooks: hooks,
    id: "persist-postgres",
    name: "Persist (PostgreSQL)",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: overrides.pluginConfig ?? {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((name: string, handler: Function, opts?: unknown) => {
      hooks.push({ name, handler, opts });
    }),
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
    resolvePath: vi.fn((p: string) => p),
  } as unknown as OpenClawPluginApi & {
    _hooks: Array<{ name: string; handler: Function; opts: unknown }>;
  };
}

describe("persist-postgres plugin registration", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  // Restore after each test
  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATABASE_URL = originalEnv;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  test("plugin has correct metadata", async () => {
    const { default: plugin } = await import("./index.js");
    expect(plugin.id).toBe("persist-postgres");
    expect(plugin.name).toBe("Persist (PostgreSQL)");
    // No kind — persistence plugins don't participate in slot management
    expect((plugin as Record<string, unknown>).kind).toBeUndefined();
  });

  test("warns and skips hook registration when databaseUrl is missing", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({ pluginConfig: {} });

    plugin.register(api);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no databaseUrl in plugin config or DATABASE_URL env"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  test("registers hooks when databaseUrl is provided via pluginConfig", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test" },
    });

    plugin.register(api);

    expect(api.logger.warn).not.toHaveBeenCalled();
    expect(api.on).toHaveBeenCalledTimes(3);
    const hookNames = api._hooks.map((h) => h.name);
    expect(hookNames).toContain("before_agent_start");
    expect(hookNames).toContain("agent_end");
    expect(hookNames).toContain("gateway_stop");
  });

  test("registers hooks when DATABASE_URL env var is set", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({ pluginConfig: {} });

    plugin.register(api);

    expect(api.on).toHaveBeenCalledTimes(3);
  });

  test("before_agent_start hook logs error on database failure", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      // Use an unreachable host to force connection failure
      pluginConfig: { databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/nope" },
    });

    plugin.register(api);

    const beforeAgentHook = api._hooks.find((h) => h.name === "before_agent_start");
    expect(beforeAgentHook).toBeDefined();

    // Invoke the hook — connection will fail, error should be caught and logged
    const result = await beforeAgentHook!.handler(
      { prompt: "test message" },
      { sessionKey: "agent:main:test" },
    );

    expect(result).toEqual({});
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("before_agent_start error"),
    );
  });

  test("init error is cached — second call does not retry", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/nope" },
    });

    plugin.register(api);

    const beforeAgentHook = api._hooks.find((h) => h.name === "before_agent_start");
    const agentEndHook = api._hooks.find((h) => h.name === "agent_end");

    // First call triggers init failure
    await beforeAgentHook!.handler({ prompt: "msg1" }, { sessionKey: "test" });
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("init failed (will not retry)"),
    );

    // Clear mock to verify second call behavior
    (api.logger.error as ReturnType<typeof vi.fn>).mockClear();

    // Second call should fail fast with cached error (no "init failed" again)
    await agentEndHook!.handler(
      { messages: [{ role: "assistant", content: "hi" }], success: true },
      { sessionKey: "test" },
    );
    expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining("agent_end error"));
    // Should NOT log "init failed" again — error was cached
    expect(api.logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("init failed (will not retry)"),
    );
  });

  test("before_agent_start returns empty object when prompt is missing", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test" },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    const result = await hook!.handler({ prompt: "" }, { sessionKey: "test" });

    expect(result).toEqual({});
    // Should not attempt database connection for empty prompt
    expect(api.logger.error).not.toHaveBeenCalled();
  });

  test("agent_end hook does nothing when no assistant message exists", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/nope" },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "agent_end");
    await hook!.handler(
      { messages: [{ role: "user", content: "hi" }], success: true },
      { sessionKey: "test" },
    );

    // No assistant message → no DB operation → no error
    expect(api.logger.error).not.toHaveBeenCalled();
  });
});

describe("content formatting utilities", () => {
  test("extracts text from string content", () => {
    expect(extractTextFromChatContent("Hello world")).toBe("Hello world");
  });

  test("extracts text from content blocks array", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromChatContent(content)).toBe("Hello world");
  });

  test("filters non-text content blocks", () => {
    const content = [
      { type: "text", text: "visible" },
      { type: "tool_use", id: "123", name: "test", input: {} },
      { type: "text", text: "also visible" },
    ];
    expect(extractTextFromChatContent(content)).toBe("visible also visible");
  });

  test("returns null for empty content blocks", () => {
    expect(extractTextFromChatContent([])).toBeNull();
    expect(
      extractTextFromChatContent([{ type: "tool_use", id: "1", name: "x", input: {} }]),
    ).toBeNull();
  });

  test("returns null for non-string, non-array content", () => {
    expect(extractTextFromChatContent(undefined)).toBeNull();
    expect(extractTextFromChatContent(null)).toBeNull();
    expect(extractTextFromChatContent(42)).toBeNull();
  });

  test("stripEnvelope removes channel envelope headers", () => {
    expect(stripEnvelope("[WhatsApp 2024-01-15 12:00Z] Hello")).toBe("Hello");
    expect(stripEnvelope("[Telegram 2024-01-15 12:00Z] Hi")).toBe("Hi");
  });

  test("stripEnvelope preserves plain messages", () => {
    expect(stripEnvelope("Hello world")).toBe("Hello world");
    expect(stripEnvelope("[not-a-channel] test")).toBe("[not-a-channel] test");
  });

  test("user prompt with envelope is formatted as structured JSON", () => {
    const rawPrompt = "[WhatsApp 2024-01-15 12:00Z] Hello doctor";
    const userText = stripEnvelope(rawPrompt).trim();
    const hasEnvelope = userText !== rawPrompt;
    expect(hasEnvelope).toBe(true);
    const content = hasEnvelope
      ? JSON.stringify({
          text: userText,
          envelope: rawPrompt.slice(0, rawPrompt.length - userText.length).trim(),
        })
      : userText;
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe("Hello doctor");
    expect(parsed.envelope).toBe("[WhatsApp 2024-01-15 12:00Z]");
  });

  test("user prompt without envelope is stored as plain text", () => {
    const rawPrompt = "Hello doctor";
    const userText = stripEnvelope(rawPrompt).trim();
    const hasEnvelope = userText !== rawPrompt;
    expect(hasEnvelope).toBe(false);
    expect(userText).toBe("Hello doctor");
  });
});
