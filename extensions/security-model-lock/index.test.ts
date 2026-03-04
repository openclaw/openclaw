import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk/types";

// Mock the plugin module
vi.mock("../index", () => {
  const sessionLocks = new Map<string, any>();

  return {
    default: function register(api: OpenClawPluginApi) {
      const config = {
        sensitiveTools: ["weather"],
        secureModel: { provider: "ollama", model: "llama3.3:8b" },
        enabled: true,
      };

      // Store hook handlers for testing
      (api as any)._hookHandlers = new Map();

      api.on = vi.fn(<K extends "before_tool_call" | "before_model_resolve">(
        hookName: K,
        handler: any,
      ) => {
        (api as any)._hookHandlers.set(hookName, handler);
      });

      api.logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      api.config = {
        get: vi.fn(() => config),
      };

      api.runtime = {
        events: {
          emit: vi.fn(),
        },
        config: {
          loadConfig: vi.fn(),
          writeConfigFile: vi.fn(),
        },
        state: {
          resolveStateDir: vi.fn(() => "/tmp/state"),
        },
      };

      api.registerCommand = vi.fn();
    },
  };
});

describe("security-model-lock plugin", () => {
  let mockApi: any;

  beforeEach(() => {
    mockApi = {
      _hookHandlers: new Map(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      config: {
        get: vi.fn(() => ({
          sensitiveTools: ["weather"],
          secureModel: { provider: "ollama", model: "llama3.3:8b" },
          enabled: true,
        })),
      },
      runtime: {
        events: { emit: vi.fn() },
        config: { loadConfig: vi.fn(), writeConfigFile: vi.fn() },
        state: { resolveStateDir: vi.fn(() => "/tmp/state") },
      },
      registerCommand: vi.fn(),
    };
  });

  describe("before_tool_call hook", () => {
    it("should detect sensitive tool and lock session", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");
      expect(handler).toBeDefined();

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "weather",
        params: { location: "Beijing" },
        runId: "test-run-1",
      };

      const ctx: PluginHookToolContext = {
        agentId: "main",
        sessionKey: "test-session-1",
        sessionId: "session-abc",
        runId: "test-run-1",
        toolName: "weather",
      };

      const result = handler(event, ctx) as PluginHookBeforeToolCallResult | void;

      // Should not block the tool call (just lock the session)
      expect(result).toBeUndefined();

      // Should log the detection
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("sensitive tool detected: weather"),
      );
    });

    it("should not trigger for non-sensitive tools", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "read_file",
        params: { path: "/tmp/test.txt" },
      };

      const ctx: PluginHookToolContext = {
        agentId: "main",
        sessionKey: "test-session-1",
        sessionId: "session-abc",
      };

      const result = handler(event, ctx) as PluginHookBeforeToolCallResult | void;

      expect(result).toBeUndefined();
      expect(mockApi.logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("sensitive tool detected"),
      );
    });

    it("should not re-lock already locked sessions", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");

      const event1: PluginHookBeforeToolCallEvent = {
        toolName: "weather",
        params: {},
      };
      const ctx1: PluginHookToolContext = {
        sessionKey: "locked-session",
      };

      // First call - should lock
      handler(event1, ctx1);

      const event2: PluginHookBeforeToolCallEvent = {
        toolName: "weather",
        params: {},
      };

      // Second call - should not log again
      handler(event2, ctx1);

      // Should only log once
      expect(mockApi.logger.info).toHaveBeenCalledTimes(1);
    });
  });

  describe("before_model_resolve hook", () => {
    it("should return secure model for locked sessions", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_model_resolve");
      expect(handler).toBeDefined();

      const event: PluginHookBeforeModelResolveEvent = {
        prompt: "Hello",
      };

      const ctx: PluginHookAgentContext = {
        agentId: "main",
        sessionKey: "locked-session",
        sessionId: "session-abc",
      };

      // Simulate locked session
      const sessionLocks = new Map();
      sessionLocks.set("locked-session", {
        lockedAt: Date.now(),
        reason: "Sensitive tool called",
      });

      const result = handler(event, ctx) as PluginHookBeforeModelResolveResult | void;

      expect(result).toEqual({
        providerOverride: "ollama",
        modelOverride: "llama3.3:8b",
      });
    });

    it("should not override model for unlocked sessions", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_model_resolve");

      const event: PluginHookBeforeModelResolveEvent = {
        prompt: "Hello",
      };

      const ctx: PluginHookAgentContext = {
        agentId: "main",
        sessionKey: "unlocked-session",
      };

      const result = handler(event, ctx) as PluginHookBeforeModelResolveResult | void;

      expect(result).toBeUndefined();
    });
  });

  describe("security-status command", () => {
    it("should be registered", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      expect(mockApi.registerCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "security-status",
          description: expect.stringContaining("locked"),
        }),
      );
    });
  });

  describe("security-unlock command", () => {
    it("should be registered", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      expect(mockApi.registerCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "security-unlock",
          description: expect.stringContaining("unlock"),
        }),
      );
    });
  });
});
