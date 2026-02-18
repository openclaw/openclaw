/**
 * Unit tests for persist-postgres plugin lifecycle.
 *
 * These tests verify plugin registration, configuration validation,
 * and error handling without requiring a running PostgreSQL instance.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
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
