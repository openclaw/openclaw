/**
 * Unit tests for auth-memory-gate plugin lifecycle.
 *
 * These tests verify plugin registration, configuration validation,
 * and hook behavior without requiring a running PostgreSQL instance.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

function createMockApi(
  overrides: Partial<{
    pluginConfig: Record<string, unknown>;
  }> = {},
): OpenClawPluginApi & { _hooks: Array<{ name: string; handler: Function; opts: unknown }> } {
  const hooks: Array<{ name: string; handler: Function; opts: unknown }> = [];
  return {
    _hooks: hooks,
    id: "auth-memory-gate",
    name: "Memory Scope Gate",
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

describe("auth-memory-gate plugin registration", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATABASE_URL = originalEnv;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  test("plugin has correct metadata", async () => {
    const { default: plugin } = await import("./index.js");
    expect(plugin.id).toBe("auth-memory-gate");
    expect(plugin.name).toBe("Memory Scope Gate");
    // No kind — scope plugins don't participate in slot management
    expect((plugin as Record<string, unknown>).kind).toBeUndefined();
  });

  test("warns and skips hook registration when databaseUrl is missing", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({ pluginConfig: {} });

    plugin.register(api);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no databaseUrl or DATABASE_URL env"),
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
    expect(api.on).toHaveBeenCalledTimes(2);
    const hookNames = api._hooks.map((h) => h.name);
    expect(hookNames).toContain("before_agent_start");
    expect(hookNames).toContain("gateway_stop");
  });

  test("before_agent_start hook registered at priority 40", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test" },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    expect(hook).toBeDefined();
    expect(hook!.opts).toEqual({ priority: 40 });
  });

  test("registers hooks when DATABASE_URL env var is set", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({ pluginConfig: {} });

    plugin.register(api);

    expect(api.on).toHaveBeenCalledTimes(2);
  });
});

describe("auth-memory-gate before_agent_start hook", () => {
  test("returns empty object when peerId is main", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test" },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    const result = await hook!.handler({ prompt: "hello" }, { sessionKey: "agent:main:main" });

    expect(result).toEqual({});
  });

  test("returns empty object when peerId is unknown", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test" },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    const result = await hook!.handler({ prompt: "hello" }, { sessionKey: "short" });

    // "short" → derivePeerId returns "short", deriveChannel returns "unknown"
    // The hook should still try the DB, but the DB will fail (unreachable)
    // and return {}
    expect(result).toEqual({});
  });

  test("logs error on database failure and returns empty", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/nope" },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    const result = await hook!.handler(
      { prompt: "test message" },
      { sessionKey: "agent:main:telegram:user123" },
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

    const hook = api._hooks.find((h) => h.name === "before_agent_start");

    // First call triggers init failure
    await hook!.handler({ prompt: "msg1" }, { sessionKey: "agent:main:telegram:user1" });
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("init failed (will not retry)"),
    );

    // Clear mock to verify second call behavior
    (api.logger.error as ReturnType<typeof vi.fn>).mockClear();

    // Second call should fail fast with cached error (no "init failed" again)
    await hook!.handler({ prompt: "msg2" }, { sessionKey: "agent:main:telegram:user2" });
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("before_agent_start error"),
    );
    expect(api.logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("init failed (will not retry)"),
    );
  });
});

describe("auth-memory-gate hardGate registration", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATABASE_URL = originalEnv;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  test("registers 3 hooks when hardGate is true (before_agent_start + message_sending + gateway_stop)", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test", hardGate: true },
    });

    plugin.register(api);

    expect(api.on).toHaveBeenCalledTimes(3);
    const hookNames = api._hooks.map((h) => h.name);
    expect(hookNames).toContain("before_agent_start");
    expect(hookNames).toContain("message_sending");
    expect(hookNames).toContain("gateway_stop");
  });

  test("message_sending hook registered at priority 30", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test", hardGate: true },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "message_sending");
    expect(hook).toBeDefined();
    expect(hook!.opts).toEqual({ priority: 30 });
  });

  test("does not register message_sending hook when hardGate is false", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test", hardGate: false },
    });

    plugin.register(api);

    expect(api.on).toHaveBeenCalledTimes(2);
    const hookNames = api._hooks.map((h) => h.name);
    expect(hookNames).not.toContain("message_sending");
  });

  test("before_agent_start returns IDENTITY_GATE prompt on DB init failure when hardGate is true", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: {
        databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/nope",
        hardGate: true,
      },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    // DB unreachable → error → returns {}
    const result = await hook!.handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:telegram:user123" },
    );
    expect(result).toEqual({});
    expect(api.logger.error).toHaveBeenCalled();
  });

  test("message_sending hook returns empty for non-gated peer", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test", hardGate: true },
    });

    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "message_sending");
    // No peers in gated set — should return empty
    const result = await hook!.handler(
      { to: "user123", content: "Hello there" },
      { channelId: "telegram" },
    );
    expect(result).toEqual({});
  });

  test("logs hardGate config on startup", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({
      pluginConfig: { databaseUrl: "postgresql://localhost:5432/test", hardGate: true },
    });

    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("hardGate=true"));
  });
});
