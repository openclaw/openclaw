/**
 * index.test.ts — Unit tests for the WikiOracle OpenClaw extension.
 *
 * Tests cover:
 *   - Plugin metadata (id, name, description).
 *   - Provider registration (id, label, aliases, auth).
 *   - Command registration (/wo) — usage, success, and error paths.
 *   - Tool registration (wikioracle_query) — success and param forwarding.
 *   - Config defaults and overrides from pluginConfig.
 *
 * createWoStream is mocked so no real process is launched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────
//  Mock createWoStream before importing the plugin
// ─────────────────────────────────────────────────────────────────

const mockCreateWoStream = vi.fn<(opts: any) => Promise<string>>();

vi.mock("./src/stream.js", () => ({
  createWoStream: (...args: unknown[]) => mockCreateWoStream(...args),
}));

import plugin from "./index.js";

// ─────────────────────────────────────────────────────────────────
//  Mock OpenClawPluginApi
// ─────────────────────────────────────────────────────────────────

interface Registration {
  provider: any | null;
  command: any | null;
  tool: { factory: any; opts: any } | null;
}

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const reg: Registration = { provider: null, command: null, tool: null };

  const api = {
    id: "wikioracle",
    name: "WikiOracle",
    source: "test",
    config: {},
    pluginConfig: pluginConfig ?? undefined,
    runtime: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerProvider: vi.fn((p: any) => {
      reg.provider = p;
    }),
    registerCommand: vi.fn((c: any) => {
      reg.command = c;
    }),
    registerTool: vi.fn((factory: any, opts: any) => {
      reg.tool = { factory, opts };
    }),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerContextEngine: vi.fn(),
    resolvePath: (p: string) => p,
    on: vi.fn(),
  };

  return { api, reg };
}

// ─────────────────────────────────────────────────────────────────
//  Plugin metadata
// ─────────────────────────────────────────────────────────────────

describe("plugin metadata", () => {
  it("has the correct id", () => {
    expect(plugin.id).toBe("wikioracle");
  });

  it("has a name", () => {
    expect(plugin.name).toBe("WikiOracle");
  });

  it("has a description mentioning bin/wo", () => {
    expect(plugin.description).toContain("bin/wo");
  });

  it("exports a register function", () => {
    expect(typeof plugin.register).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────
//  Provider registration
// ─────────────────────────────────────────────────────────────────

describe("provider registration", () => {
  it("registers a provider with id 'wikioracle'", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    expect(api.registerProvider).toHaveBeenCalledOnce();
    expect(reg.provider.id).toBe("wikioracle");
  });

  it("sets label to 'WikiOracle'", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.provider.label).toBe("WikiOracle");
  });

  it("includes 'wo' and 'oracle' as aliases", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.provider.aliases).toContain("wo");
    expect(reg.provider.aliases).toContain("oracle");
  });

  it("has a single auth method with id 'local'", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.provider.auth).toHaveLength(1);
    expect(reg.provider.auth[0].id).toBe("local");
  });

  it("auth.run() returns { ok: true }", async () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    const result = await reg.provider.auth[0].run();
    expect(result).toEqual({ ok: true });
  });

  it("sets docsPath", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.provider.docsPath).toBe("/providers/wikioracle");
  });

  it("declares no required env vars", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.provider.envVars).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
//  /wo command
// ─────────────────────────────────────────────────────────────────

describe("/wo command registration", () => {
  it("registers a command named 'wo'", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    expect(api.registerCommand).toHaveBeenCalledOnce();
    expect(reg.command.name).toBe("wo");
  });

  it("accepts args", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.command.acceptsArgs).toBe(true);
  });

  it("does not require auth", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.command.requireAuth).toBe(false);
  });
});

describe("/wo command handler", () => {
  beforeEach(() => {
    mockCreateWoStream.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns usage text when args is empty", async () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const result = await reg.command.handler({
      args: "",
      channel: "test",
      commandBody: "/wo",
      config: {},
      isAuthorizedSender: true,
    });

    expect(result.text).toContain("Usage:");
    expect(result.text).toContain("/wo");
    expect(mockCreateWoStream).not.toHaveBeenCalled();
  });

  it("returns usage text when args is undefined", async () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const result = await reg.command.handler({
      args: undefined,
      channel: "test",
      commandBody: "/wo",
      config: {},
      isAuthorizedSender: true,
    });

    expect(result.text).toContain("Usage:");
  });

  it("returns usage text when args is only whitespace", async () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const result = await reg.command.handler({
      args: "   \t  ",
      channel: "test",
      commandBody: "/wo",
      config: {},
      isAuthorizedSender: true,
    });

    expect(result.text).toContain("Usage:");
  });

  it("calls createWoStream with the message and returns the response", async () => {
    mockCreateWoStream.mockResolvedValue("The capital of France is Paris.");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const result = await reg.command.handler({
      args: "What is the capital of France?",
      channel: "slack-general",
      commandBody: "/wo What is the capital of France?",
      config: {},
      isAuthorizedSender: true,
    });

    expect(result.text).toBe("The capital of France is Paris.");
    expect(mockCreateWoStream).toHaveBeenCalledOnce();
    expect(mockCreateWoStream).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "What is the capital of France?",
      }),
    );
  });

  it("passes default config values to createWoStream", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi(); // no pluginConfig
    plugin.register(api as any);

    await reg.command.handler({
      args: "test",
      channel: "test",
      commandBody: "/wo test",
      config: {},
      isAuthorizedSender: true,
    });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.woPath).toBe("../bin/wo");
    expect(callOpts.serverUrl).toBe("https://127.0.0.1:8888");
    expect(callOpts.insecure).toBe(true);
    expect(callOpts.stateful).toBe(true);
    expect(callOpts.stateFile).toBe("state.xml");
    expect(callOpts.token).toBeUndefined();
  });

  it("passes overridden config values to createWoStream", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi({
      woPath: "/opt/wo/bin/wo",
      serverUrl: "https://prod.example.com:443",
      insecure: false,
      stateful: false,
      stateFile: "/data/state.xml",
      token: "prod-token-abc",
    });
    plugin.register(api as any);

    await reg.command.handler({
      args: "test",
      channel: "test",
      commandBody: "/wo test",
      config: {},
      isAuthorizedSender: true,
    });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.woPath).toBe("/opt/wo/bin/wo");
    expect(callOpts.serverUrl).toBe("https://prod.example.com:443");
    expect(callOpts.insecure).toBe(false);
    expect(callOpts.stateful).toBe(false);
    expect(callOpts.stateFile).toBe("/data/state.xml");
    expect(callOpts.token).toBe("prod-token-abc");
  });

  it("returns error text when createWoStream throws an Error", async () => {
    mockCreateWoStream.mockRejectedValue(
      new Error("bin/wo exited with code 1: Connection refused"),
    );

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const result = await reg.command.handler({
      args: "test",
      channel: "test",
      commandBody: "/wo test",
      config: {},
      isAuthorizedSender: true,
    });

    expect(result.text).toContain("WikiOracle error:");
    expect(result.text).toContain("Connection refused");
  });

  it("returns error text when createWoStream throws a non-Error", async () => {
    mockCreateWoStream.mockRejectedValue("raw string error");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const result = await reg.command.handler({
      args: "test",
      channel: "test",
      commandBody: "/wo test",
      config: {},
      isAuthorizedSender: true,
    });

    expect(result.text).toContain("WikiOracle error:");
    expect(result.text).toContain("raw string error");
  });

  it("logs the error via api.logger.error", async () => {
    mockCreateWoStream.mockRejectedValue(new Error("timeout"));

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    await reg.command.handler({
      args: "test",
      channel: "test",
      commandBody: "/wo test",
      config: {},
      isAuthorizedSender: true,
    });

    expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });
});

// ─────────────────────────────────────────────────────────────────
//  wikioracle_query tool
// ─────────────────────────────────────────────────────────────────

describe("wikioracle_query tool registration", () => {
  it("registers a tool factory", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    expect(api.registerTool).toHaveBeenCalledOnce();
    expect(typeof reg.tool!.factory).toBe("function");
  });

  it("marks the tool as optional", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);
    expect(reg.tool!.opts).toEqual({ optional: true });
  });

  it("factory returns a tool with correct name and type", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("wikioracle_query");
  });

  it("tool has a description mentioning truth table and DoT", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    expect(tool.function.description).toContain("truth table");
    expect(tool.function.description).toContain("DegreeOfTruth");
  });

  it("tool parameters require 'message' and optionally accept provider, model, conversationId", () => {
    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    const params = tool.function.parameters;
    expect(params.required).toEqual(["message"]);
    expect(params.properties).toHaveProperty("message");
    expect(params.properties).toHaveProperty("provider");
    expect(params.properties).toHaveProperty("model");
    expect(params.properties).toHaveProperty("conversationId");
  });
});

describe("wikioracle_query tool handler", () => {
  beforeEach(() => {
    mockCreateWoStream.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls createWoStream with the message and returns content array", async () => {
    mockCreateWoStream.mockResolvedValue("WikiOracle says hello");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    const result = await tool.handler({ message: "Hello" });

    expect(result).toEqual({
      content: [{ type: "text", text: "WikiOracle says hello" }],
    });
    expect(mockCreateWoStream).toHaveBeenCalledWith(expect.objectContaining({ message: "Hello" }));
  });

  it("forwards provider and model overrides to createWoStream", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    await tool.handler({
      message: "test",
      provider: "anthropic",
      model: "claude-3",
    });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.provider).toBe("anthropic");
    expect(callOpts.model).toBe("claude-3");
  });

  it("forwards conversationId to createWoStream", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    await tool.handler({
      message: "follow-up question",
      conversationId: "conv-42",
    });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.conversationId).toBe("conv-42");
  });

  it("uses default config values", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    await tool.handler({ message: "test" });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.woPath).toBe("../bin/wo");
    expect(callOpts.serverUrl).toBe("https://127.0.0.1:8888");
    expect(callOpts.insecure).toBe(true);
    expect(callOpts.stateful).toBe(true);
  });

  it("uses overridden config values", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi({
      woPath: "/custom/bin/wo",
      serverUrl: "https://custom:9999",
      insecure: false,
      stateful: false,
      stateFile: "/custom/state.xml",
      token: "custom-token",
    });
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    await tool.handler({ message: "test" });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.woPath).toBe("/custom/bin/wo");
    expect(callOpts.serverUrl).toBe("https://custom:9999");
    expect(callOpts.insecure).toBe(false);
    expect(callOpts.stateful).toBe(false);
    expect(callOpts.stateFile).toBe("/custom/state.xml");
    expect(callOpts.token).toBe("custom-token");
  });

  it("propagates errors from createWoStream", async () => {
    mockCreateWoStream.mockRejectedValue(new Error("server down"));

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    await expect(tool.handler({ message: "test" })).rejects.toThrow("server down");
  });

  it("leaves optional params undefined when not provided", async () => {
    mockCreateWoStream.mockResolvedValue("ok");

    const { api, reg } = createMockApi();
    plugin.register(api as any);

    const tool = reg.tool!.factory({});
    await tool.handler({ message: "just a message" });

    const callOpts = mockCreateWoStream.mock.calls[0][0];
    expect(callOpts.provider).toBeUndefined();
    expect(callOpts.model).toBeUndefined();
    expect(callOpts.conversationId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────────────────────────────

describe("registration logging", () => {
  it("logs an info message after registration", () => {
    const { api } = createMockApi();
    plugin.register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("wikioracle:"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("registered"));
  });

  it("includes serverUrl and stateful flag in log message", () => {
    const { api } = createMockApi({
      serverUrl: "https://prod:443",
      stateful: false,
    });
    plugin.register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("server=https://prod:443"),
    );
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("stateful=false"));
  });
});
