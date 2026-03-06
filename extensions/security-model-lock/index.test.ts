import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";

// Mock node:fs module
vi.mock("node:fs", () => ({
  default: {
    readdirSync: vi.fn(() => [
      { name: "weather", isDirectory: () => true },
      { name: "notion", isDirectory: () => true },
      { name: "slack", isDirectory: () => true },
    ]),
    readFileSync: vi.fn((filePath: string) => {
      if (filePath.endsWith("SKILL.md")) {
        const skillName = filePath.split(/[\\/]/).slice(-2, -1)[0];
        return `name: ${skillName}\ndescription: A test skill`;
      }
      return "";
    }),
  },
  readdirSync: vi.fn(() => [
    { name: "weather", isDirectory: () => true },
    { name: "notion", isDirectory: () => true },
    { name: "slack", isDirectory: () => true },
  ]),
  readFileSync: vi.fn((filePath: string) => {
    if (filePath.endsWith("SKILL.md")) {
      const skillName = filePath.split(/[\\/]/).slice(-2, -1)[0];
      return `name: ${skillName}\ndescription: A test skill`;
    }
    return "";
  }),
}));

// Mock node:path module
vi.mock("node:path", () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join("/")),
    normalize: vi.fn((p: string) => p.replace(/\\/g, "/")),
    relative: vi.fn((from: string, to: string) => {
      if (to.startsWith(from)) {
        return to.slice(from.length + 1);
      }
      return to;
    }),
    sep: "/",
  },
  join: vi.fn((...args: string[]) => args.join("/")),
  normalize: vi.fn((p: string) => p.replace(/\\/g, "/")),
  relative: vi.fn((from: string, to: string) => {
    if (to.startsWith(from)) {
      return to.slice(from.length + 1);
    }
    return to;
  }),
  sep: "/",
}));

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
          sensitiveSkills: ["weather"],
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
    it("should detect sensitive skill via read tool and block", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");
      expect(handler).toBeDefined();

      // Simulate read tool calling a sensitive skill file
      const event: PluginHookBeforeToolCallEvent = {
        toolName: "read",
        params: { file_path: "/app/skills/weather/SKILL.md" },
        runId: "test-run-1",
      };

      const ctx: PluginHookToolContext = {
        agentId: "main",
        sessionKey: "test-session-1",
        sessionId: "session-abc",
        runId: "test-run-1",
        toolName: "read",
      };

      const result = handler(event, ctx) as PluginHookBeforeToolCallResult | void;

      // Should block the tool call
      expect(result).toEqual({
        block: true,
        blockReason: expect.stringContaining("检测到敏感 skill"),
      });

      // Should log the detection
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('sensitive skill detected: weather via read /app/skills/weather/SKILL.md'),
      );
    });

    it("should not trigger for read tool on non-sensitive files", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "read",
        params: { file_path: "/tmp/test.txt" },
      };

      const ctx: PluginHookToolContext = {
        agentId: "main",
        sessionKey: "test-session-1",
        sessionId: "session-abc",
      };

      const result = handler(event, ctx) as PluginHookBeforeToolCallResult | void;

      expect(result).toBeUndefined();
      expect(mockApi.logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("sensitive skill detected"),
      );
    });

    it("should not trigger for non-read tools", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "weather",
        params: { location: "Beijing" },
      };

      const ctx: PluginHookToolContext = {
        agentId: "main",
        sessionKey: "test-session-1",
        sessionId: "session-abc",
      };

      const result = handler(event, ctx) as PluginHookBeforeToolCallResult | void;

      expect(result).toBeUndefined();
    });

    it("should not re-block if session already locked", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");

      const event1: PluginHookBeforeToolCallEvent = {
        toolName: "read",
        params: { file_path: "/app/skills/weather/SKILL.md" },
      };
      const ctx1: PluginHookToolContext = {
        sessionKey: "locked-session",
      };

      // First call - should lock and block
      const result1 = handler(event1, ctx1) as PluginHookBeforeToolCallResult;
      expect(result1.block).toBe(true);

      const event2: PluginHookBeforeToolCallEvent = {
        toolName: "read",
        params: { file_path: "/app/skills/weather/SKILL.md" },
      };

      // Second call - should not block again (session already locked)
      const result2 = handler(event2, ctx1) as PluginHookBeforeToolCallResult | void;
      expect(result2).toBeUndefined();
    });

    it("should not trigger if file_path is missing", async () => {
      const { default: register } = await import("../index");
      register(mockApi);

      const handler = mockApi._hookHandlers.get("before_tool_call");

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "read",
        params: {},
      };

      const ctx: PluginHookToolContext = {
        sessionKey: "test-session-1",
      };

      const result = handler(event, ctx) as PluginHookBeforeToolCallResult | void;

      expect(result).toBeUndefined();
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

      // First, lock the session via before_tool_call
      const lockEvent: PluginHookBeforeToolCallEvent = {
        toolName: "read",
        params: { file_path: "/app/skills/weather/SKILL.md" },
      };
      const lockCtx: PluginHookToolContext = {
        agentId: "main",
        sessionKey: "locked-session",
        sessionId: "session-abc",
        runId: "test-run",
        toolName: "read",
      };
      handler(lockEvent, lockCtx);

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
