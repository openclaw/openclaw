import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  shouldLogHandoff,
  resolveHandoffLogLevel,
  resolveWorkspaceLocationFromSessionKey,
  resolveSessionIdFromKey,
  logHandoffSpawn,
  logHandoffComplete,
  type HandoffLoggingOptions,
} from "./handoff-logging.js";

// Mock dependencies
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  parseAgentSessionKey: vi.fn(),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(),
  loadSessionStore: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { loadConfig } from "../config/config.js";
import { resolveStorePath, loadSessionStore } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockResolveAgentWorkspaceDir = vi.mocked(resolveAgentWorkspaceDir);
const mockParseAgentSessionKey = vi.mocked(parseAgentSessionKey);
const mockResolveStorePath = vi.mocked(resolveStorePath);
const mockLoadSessionStore = vi.mocked(loadSessionStore);
const mockCreateSubsystemLogger = vi.mocked(createSubsystemLogger);

describe("handoff-logging", () => {
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockCreateSubsystemLogger.mockReturnValue(mockLogger as any);
    mockLoadConfig.mockReturnValue({} as OpenClawConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("shouldLogHandoff", () => {
    it("returns false when no config or options provided", () => {
      const result = shouldLogHandoff(undefined, undefined);
      expect(result).toBe(false);
    });

    it("returns false when config.agents.handoffLogging is undefined", () => {
      const config: OpenClawConfig = { agents: {} };
      const result = shouldLogHandoff(config, undefined);
      expect(result).toBe(false);
    });

    it("returns true when config.agents.handoffLogging.enabled is true", () => {
      const config: OpenClawConfig = {
        agents: {
          handoffLogging: { enabled: true },
        },
      };
      const result = shouldLogHandoff(config, undefined);
      expect(result).toBe(true);
    });

    it("prioritizes runtime options over config", () => {
      const config: OpenClawConfig = {
        agents: {
          handoffLogging: { enabled: false },
        },
      };
      const options: HandoffLoggingOptions = { enabled: true };
      const result = shouldLogHandoff(config, options);
      expect(result).toBe(true);
    });

    it("uses runtime options when config is disabled", () => {
      const config: OpenClawConfig = {
        agents: {
          handoffLogging: { enabled: true },
        },
      };
      const options: HandoffLoggingOptions = { enabled: false };
      const result = shouldLogHandoff(config, options);
      expect(result).toBe(false);
    });
  });

  describe("resolveHandoffLogLevel", () => {
    it('returns "info" when no config or options provided', () => {
      const result = resolveHandoffLogLevel(undefined, undefined);
      expect(result).toBe("info");
    });

    it("returns config level when options not provided", () => {
      const config: OpenClawConfig = {
        agents: {
          handoffLogging: { level: "debug" },
        },
      };
      const result = resolveHandoffLogLevel(config, undefined);
      expect(result).toBe("debug");
    });

    it("prioritizes options level over config", () => {
      const config: OpenClawConfig = {
        agents: {
          handoffLogging: { level: "info" },
        },
      };
      const options: HandoffLoggingOptions = { level: "warn" };
      const result = resolveHandoffLogLevel(config, options);
      expect(result).toBe("warn");
    });

    it('defaults to "info" when config.agents.handoffLogging is undefined', () => {
      const config: OpenClawConfig = { agents: {} };
      const result = resolveHandoffLogLevel(config, undefined);
      expect(result).toBe("info");
    });
  });

  describe("resolveWorkspaceLocationFromSessionKey", () => {
    it('returns "(unknown)" when session key cannot be parsed', () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue(null as any);

      const result = resolveWorkspaceLocationFromSessionKey("invalid");
      expect(result).toBe("(unknown)");
    });

    it('returns "(unknown)" when agentId is missing from parsed key', () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "" } as any);

      const result = resolveWorkspaceLocationFromSessionKey("agent::");
      expect(result).toBe("(unknown)");
    });

    it("returns absolute path when workspace can be resolved", () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveAgentWorkspaceDir.mockReturnValue("/Users/user/workspace/main");

      const result = resolveWorkspaceLocationFromSessionKey("agent:main:main");
      expect(result).toBe("/Users/user/workspace/main");
      expect(mockResolveAgentWorkspaceDir).toHaveBeenCalledWith({}, "main");
    });

    it('returns "(error resolving workspace)" when resolution throws', () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveAgentWorkspaceDir.mockImplementation(() => {
        throw new Error("Test error");
      });

      const result = resolveWorkspaceLocationFromSessionKey("agent:main:main");
      expect(result).toBe("(error resolving workspace)");
    });
  });

  describe("resolveSessionIdFromKey", () => {
    it('returns "(unknown)" when session key cannot be parsed', () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue(null as any);

      const result = resolveSessionIdFromKey("invalid");
      expect(result).toBe("(unknown)");
    });

    it('returns "(pending)" when session not in store', () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveStorePath.mockReturnValue("/path/to/store.json");
      mockLoadSessionStore.mockReturnValue({});

      const result = resolveSessionIdFromKey("agent:main:main");
      expect(result).toBe("(pending)");
    });

    it("returns sessionId when found in store", () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveStorePath.mockReturnValue("/path/to/store.json");
      mockLoadSessionStore.mockReturnValue({
        "agent:main:main": { sessionId: "sess_abc123" } as any,
      });

      const result = resolveSessionIdFromKey("agent:main:main");
      expect(result).toBe("sess_abc123");
    });

    it('returns "(unknown)" when store read fails', () => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveStorePath.mockImplementation(() => {
        throw new Error("Test error");
      });

      const result = resolveSessionIdFromKey("agent:main:main");
      expect(result).toBe("(unknown)");
    });
  });

  describe("logHandoffSpawn", () => {
    beforeEach(() => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveAgentWorkspaceDir.mockReturnValue("/Users/user/workspace");
      mockResolveStorePath.mockReturnValue("/path/to/store.json");
      mockLoadSessionStore.mockReturnValue({});
    });

    it("does not log when logging is disabled", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: false } },
      } as OpenClawConfig);

      logHandoffSpawn({
        fromSessionKey: "agent:main:main",
        toSessionKey: "agent:main:subagent:uuid",
        task: "Test task",
      });

      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("logs at info level when enabled with default level", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: true } },
      } as OpenClawConfig);

      logHandoffSpawn({
        fromSessionKey: "agent:main:main",
        toSessionKey: "agent:main:subagent:uuid",
        task: "Test task",
      });

      expect(mockLogger.info).toHaveBeenCalledWith("Agent handoff spawn", expect.any(Object));
    });

    it("logs at debug level when configured", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: true, level: "debug" } },
      } as OpenClawConfig);

      logHandoffSpawn({
        fromSessionKey: "agent:main:main",
        toSessionKey: "agent:main:subagent:uuid",
        task: "Test task",
      });

      expect(mockLogger.debug).toHaveBeenCalledWith("Agent handoff spawn", expect.any(Object));
    });

    it("includes all context fields in log data", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: true } },
      } as OpenClawConfig);

      logHandoffSpawn({
        fromSessionKey: "agent:main:main",
        toSessionKey: "agent:main:subagent:uuid",
        task: "Test task",
        contextInherited: {
          channel: "telegram",
          accountId: "+1234567890",
          modelOverride: "anthropic/claude-opus-4-5",
          thinkingOverride: "high",
          cleanup: "delete",
          label: "test-label",
          runTimeoutSeconds: 300,
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Agent handoff spawn",
        expect.objectContaining({
          event: "agent.handoff.spawn",
          reason: "Test task",
          contextInherited: expect.objectContaining({
            channel: "telegram",
            accountId: "+1234567890",
            modelOverride: "anthropic/claude-opus-4-5",
            thinkingOverride: "high",
            cleanup: "delete",
            label: "test-label",
            runTimeoutSeconds: 300,
          }),
        }),
      );
    });
  });

  describe("logHandoffComplete", () => {
    beforeEach(() => {
      mockLoadConfig.mockReturnValue({} as OpenClawConfig);
      mockParseAgentSessionKey.mockReturnValue({ agentId: "main" } as any);
      mockResolveAgentWorkspaceDir.mockReturnValue("/Users/user/workspace");
      mockResolveStorePath.mockReturnValue("/path/to/store.json");
      mockLoadSessionStore.mockReturnValue({});
    });

    it("does not log when logging is disabled", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: false } },
      } as OpenClawConfig);

      logHandoffComplete({
        fromSessionKey: "agent:main:subagent:uuid",
        toSessionKey: "agent:main:main",
        outcome: { status: "ok" },
      });

      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it("logs at info level when enabled with default level", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: true } },
      } as OpenClawConfig);

      logHandoffComplete({
        fromSessionKey: "agent:main:subagent:uuid",
        toSessionKey: "agent:main:main",
        outcome: { status: "ok" },
      });

      expect(mockLogger.info).toHaveBeenCalledWith("Agent handoff complete", expect.any(Object));
    });

    it("includes outcome and stats in log data", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: true } },
      } as OpenClawConfig);

      logHandoffComplete({
        fromSessionKey: "agent:main:subagent:uuid",
        toSessionKey: "agent:main:main",
        outcome: { status: "ok" },
        stats: {
          runtimeMs: 45000,
          inputTokens: 12000,
          outputTokens: 3500,
          totalTokens: 15500,
          estimatedCost: "$0.23",
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Agent handoff complete",
        expect.objectContaining({
          event: "agent.handoff.complete",
          outcome: { status: "ok" },
          stats: {
            runtimeMs: 45000,
            inputTokens: 12000,
            outputTokens: 3500,
            totalTokens: 15500,
            estimatedCost: "$0.23",
          },
        }),
      );
    });

    it("handles error outcomes", () => {
      mockLoadConfig.mockReturnValue({
        agents: { handoffLogging: { enabled: true } },
      } as OpenClawConfig);

      logHandoffComplete({
        fromSessionKey: "agent:main:subagent:uuid",
        toSessionKey: "agent:main:main",
        outcome: { status: "error", error: "Test error" },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Agent handoff complete",
        expect.objectContaining({
          outcome: { status: "error", error: "Test error" },
        }),
      );
    });
  });
});
