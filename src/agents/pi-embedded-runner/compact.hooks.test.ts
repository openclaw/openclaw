import { beforeEach, describe, expect, it, vi } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

const {
  hookRunner,
  ensureRuntimePluginsLoaded,
  resolveContextEngineMock,
  resolveModelMock,
  sessionCompactImpl,
  triggerInternalHook,
  sanitizeSessionHistoryMock,
  contextEngineCompactMock,
  getMemorySearchManagerMock,
  resolveMemorySearchConfigMock,
  resolveSessionAgentIdMock,
  estimateTokensMock,
  sessionAbortCompactionMock,
  createOpenClawCodingToolsMock,
} = vi.hoisted(() => {
  const contextEngineCompactMock = vi.fn(async () => ({
    ok: true as boolean,
    compacted: true as boolean,
    reason: undefined as string | undefined,
    result: { summary: "engine-summary", tokensAfter: 50 } as
      | { summary: string; tokensAfter: number }
      | undefined,
  }));

  return {
    hookRunner: {
      hasHooks: vi.fn(),
      runBeforeCompaction: vi.fn(),
      runAfterCompaction: vi.fn(),
    },
    ensureRuntimePluginsLoaded: vi.fn(),
    resolveContextEngineMock: vi.fn(async () => ({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
    })),
    resolveModelMock: vi.fn(
      (_provider?: string, _modelId?: string, _agentDir?: string, _cfg?: unknown) => ({
        model: { provider: "openai", api: "responses", id: "fake", input: [] },
        error: null,
        authStorage: { setRuntimeApiKey: vi.fn() },
        modelRegistry: {},
      }),
    ),
    sessionCompactImpl: vi.fn(async () => ({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: { ok: true },
    })),
    triggerInternalHook: vi.fn(),
    sanitizeSessionHistoryMock: vi.fn(async (params: { messages: unknown[] }) => params.messages),
    contextEngineCompactMock,
    getMemorySearchManagerMock: vi.fn(async () => ({
      manager: {
        sync: vi.fn(async () => {}),
      },
    })),
    resolveMemorySearchConfigMock: vi.fn(() => ({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: true,
        },
      },
    })),
    resolveSessionAgentIdMock: vi.fn(() => "main"),
    estimateTokensMock: vi.fn((_message?: unknown) => 10),
    sessionAbortCompactionMock: vi.fn(),
    createOpenClawCodingToolsMock: vi.fn(() => []),
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

vi.mock("../runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded,
}));

vi.mock("../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
    "../../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: vi.fn(() => []),
}));

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    AuthStorage: class AuthStorage {},
    ModelRegistry: class ModelRegistry {},
    createAgentSession: vi.fn(async () => {
      const session = {
        sessionId: "session-1",
        messages: [
          { role: "user", content: "hello", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "exec",
            content: [{ type: "text", text: "output" }],
            isError: false,
            timestamp: 3,
          },
        ],
        agent: {
          replaceMessages: vi.fn((messages: unknown[]) => {
            session.messages = [...(messages as typeof session.messages)];
          }),
          streamFn: vi.fn(),
        },
        compact: vi.fn(async () => {
          // simulate compaction trimming to a single message
          session.messages.splice(1);
          return await sessionCompactImpl();
        }),
        abortCompaction: sessionAbortCompactionMock,
        dispose: vi.fn(),
      };
      return { session };
    }),
    SessionManager: {
      open: vi.fn(() => ({})),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
    estimateTokens: estimateTokensMock,
  };
});

vi.mock("../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: vi.fn(() => ({
    flushPendingToolResults: vi.fn(),
  })),
}));

vi.mock("../pi-settings.js", () => ({
  ensurePiCompactionReserveTokens: vi.fn(),
  resolveCompactionReserveTokensFloor: vi.fn(() => 0),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../model-auth.js", () => ({
  applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
  getApiKeyForModel: vi.fn(async () => ({ apiKey: "test", mode: "env" })),
  resolveModelAuthMode: vi.fn(() => "env"),
}));

vi.mock("../sandbox.js", () => ({
  resolveSandboxContext: vi.fn(async () => null),
}));

vi.mock("../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: vi.fn(async () => {}),
}));

vi.mock("../session-write-lock.js", () => ({
  acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 0),
}));

vi.mock("../../context-engine/index.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: resolveContextEngineMock,
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: vi.fn((_lane: unknown, task: () => unknown) => task()),
}));

vi.mock("./lanes.js", () => ({
  resolveSessionLane: vi.fn(() => "test-session-lane"),
  resolveGlobalLane: vi.fn(() => "test-global-lane"),
}));

vi.mock("../context-window-guard.js", () => ({
  resolveContextWindowInfo: vi.fn(() => ({ tokens: 128_000 })),
}));

vi.mock("../bootstrap-files.js", () => ({
  makeBootstrapWarn: vi.fn(() => () => {}),
  resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
}));

vi.mock("../docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn(async () => undefined),
}));

vi.mock("../channel-tools.js", () => ({
  listChannelSupportedActions: vi.fn(() => undefined),
  resolveChannelMessageToolHints: vi.fn(() => undefined),
}));

vi.mock("../pi-tools.js", () => ({
  createOpenClawCodingTools: createOpenClawCodingToolsMock,
}));

vi.mock("./google.js", () => ({
  logToolSchemasForGoogle: vi.fn(),
  sanitizeSessionHistory: sanitizeSessionHistoryMock,
  sanitizeToolsForGoogle: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));

vi.mock("./tool-split.js", () => ({
  splitSdkTools: vi.fn(() => ({ builtInTools: [], customTools: [] })),
}));

vi.mock("../transcript-policy.js", () => ({
  resolveTranscriptPolicy: vi.fn(() => ({
    allowSyntheticToolResults: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
  })),
}));

vi.mock("./extensions.js", () => ({
  buildEmbeddedExtensionFactories: vi.fn(() => ({ factories: [] })),
}));

vi.mock("./history.js", () => ({
  getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
  limitHistoryTurns: vi.fn((msgs: unknown[]) => msgs.slice(0, 2)),
}));

vi.mock("../skills.js", () => ({
  applySkillEnvOverrides: vi.fn(() => () => {}),
  applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
  loadWorkspaceSkillEntries: vi.fn(() => []),
  resolveSkillsPromptForRun: vi.fn(() => undefined),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp"),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: resolveSessionAgentIdMock,
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
}));

vi.mock("../memory-search.js", () => ({
  resolveMemorySearchConfig: resolveMemorySearchConfigMock,
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("../date-time.js", () => ({
  formatUserTime: vi.fn(() => ""),
  resolveUserTimeFormat: vi.fn(() => ""),
  resolveUserTimezone: vi.fn(() => ""),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_MODEL: "fake-model",
  DEFAULT_PROVIDER: "openai",
  DEFAULT_CONTEXT_TOKENS: 128_000,
}));

vi.mock("../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "machine"),
}));

vi.mock("../../config/channel-capabilities.js", () => ({
  resolveChannelCapabilities: vi.fn(() => undefined),
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  normalizeMessageChannel: vi.fn(() => undefined),
}));

vi.mock("../pi-embedded-helpers.js", () => ({
  ensureSessionHeader: vi.fn(async () => {}),
  validateAnthropicTurns: vi.fn((m: unknown[]) => m),
  validateGeminiTurns: vi.fn((m: unknown[]) => m),
}));

vi.mock("../pi-project-settings.js", () => ({
  createPreparedEmbeddedPiSettingsManager: vi.fn(() => ({
    getGlobalSettings: vi.fn(() => ({})),
  })),
}));

vi.mock("./sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: vi.fn(() => undefined),
}));

vi.mock("./model.js", () => ({
  buildModelAliasLines: vi.fn(() => []),
  resolveModel: resolveModelMock,
  resolveModelAsync: vi.fn(
    async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) =>
      resolveModelMock(provider, modelId, agentDir, cfg),
  ),
}));

vi.mock("./session-manager-cache.js", () => ({
  prewarmSessionFile: vi.fn(async () => {}),
  trackSessionManagerAccess: vi.fn(),
}));

vi.mock("./system-prompt.js", () => ({
  applySystemPromptOverrideToSession: vi.fn(),
  buildEmbeddedSystemPrompt: vi.fn(() => ""),
  createSystemPromptOverride: vi.fn(() => () => ""),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => String(err)),
  mapThinkingLevel: vi.fn(() => "off"),
  resolveExecToolDefaults: vi.fn(() => undefined),
}));

import { getApiProvider, unregisterApiProviders } from "@mariozechner/pi-ai";
import { getCustomApiRegistrySourceId } from "../custom-api-registry.js";
import { compactEmbeddedPiSessionDirect, compactEmbeddedPiSession } from "./compact.js";

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const TEST_SESSION_FILE = "/tmp/session.jsonl";
const TEST_WORKSPACE_DIR = "/tmp";
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";

function mockResolvedModel() {
  resolveModelMock.mockReset();
  resolveModelMock.mockReturnValue({
    model: { provider: "openai", api: "responses", id: "fake", input: [] },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  });
}

function compactionConfig(mode: "await" | "off" | "async") {
  return {
    agents: {
      defaults: {
        compaction: {
          postIndexSync: mode,
        },
      },
    },
  } as never;
}

function directCompactionArgs(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_FILE,
    workspaceDir: TEST_WORKSPACE_DIR,
    customInstructions: TEST_CUSTOM_INSTRUCTIONS,
    ...overrides,
  };
}

function wrappedCompactionArgs(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_FILE,
    workspaceDir: TEST_WORKSPACE_DIR,
    customInstructions: TEST_CUSTOM_INSTRUCTIONS,
    enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    ...overrides,
  };
}

const sessionHook = (action: string) =>
  triggerInternalHook.mock.calls.find(
    (call) => call[0]?.type === "session" && call[0]?.action === action,
  )?.[0];

describe("compactEmbeddedPiSessionDirect hooks", () => {
  beforeEach(() => {
    ensureRuntimePluginsLoaded.mockReset();
    triggerInternalHook.mockClear();
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    mockResolvedModel();
    sessionCompactImpl.mockReset();
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: { ok: true },
    });
    sanitizeSessionHistoryMock.mockReset();
    sanitizeSessionHistoryMock.mockImplementation(async (params: { messages: unknown[] }) => {
      return params.messages;
    });
    getMemorySearchManagerMock.mockReset();
    getMemorySearchManagerMock.mockResolvedValue({
      manager: {
        sync: vi.fn(async () => {}),
      },
    });
    resolveMemorySearchConfigMock.mockReset();
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: true,
        },
      },
    });
    resolveSessionAgentIdMock.mockReset();
    resolveSessionAgentIdMock.mockReturnValue("main");
    estimateTokensMock.mockReset();
    estimateTokensMock.mockReturnValue(10);
    sessionAbortCompactionMock.mockReset();
    unregisterApiProviders(getCustomApiRegistrySourceId("ollama"));
  });

  async function runDirectCompaction(customInstructions = TEST_CUSTOM_INSTRUCTIONS) {
    return await compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        customInstructions,
      }),
    );
  }

  it("bootstraps runtime plugins with the resolved workspace", async () => {
    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in during compaction bootstrap", async () => {
    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("emits internal + plugin compaction hooks with counts", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    let sanitizedCount = 0;
    sanitizeSessionHistoryMock.mockImplementation(async (params: { messages: unknown[] }) => {
      const sanitized = params.messages.slice(1);
      sanitizedCount = sanitized.length;
      return sanitized;
    });

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      customInstructions: "focus on decisions",
    });

    expect(result.ok).toBe(true);
    expect(sessionHook("compact:before")).toMatchObject({
      type: "session",
      action: "compact:before",
    });
    const beforeContext = sessionHook("compact:before")?.context;
    const afterContext = sessionHook("compact:after")?.context;

    expect(beforeContext).toMatchObject({
      messageCount: 2,
      tokenCount: 20,
      messageCountOriginal: sanitizedCount,
      tokenCountOriginal: sanitizedCount * 10,
    });
    expect(afterContext).toMatchObject({
      messageCount: 1,
      compactedCount: 1,
    });
    expect(afterContext?.compactedCount).toBe(
      (beforeContext?.messageCountOriginal as number) - (afterContext?.messageCount as number),
    );

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 2,
        tokenCount: 20,
      }),
      expect.objectContaining({ sessionKey: "agent:main:session-1", messageProvider: "telegram" }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: 1,
        tokenCount: 10,
        compactedCount: 1,
      },
      expect.objectContaining({ sessionKey: "agent:main:session-1", messageProvider: "telegram" }),
    );
  });

  it("uses sessionId as hook session key fallback when sessionKey is missing", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
    });

    expect(result.ok).toBe(true);
    expect(sessionHook("compact:before")?.sessionKey).toBe("session-1");
    expect(sessionHook("compact:after")?.sessionKey).toBe("session-1");
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
  });

  it("applies validated transcript before hooks even when it becomes empty", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    sanitizeSessionHistoryMock.mockResolvedValue([]);

    const result = await runDirectCompaction();

    expect(result.ok).toBe(true);
    const beforeContext = sessionHook("compact:before")?.context;
    expect(beforeContext).toMatchObject({
      messageCountOriginal: 0,
      tokenCountOriginal: 0,
      messageCount: 0,
      tokenCount: 0,
    });
  });
  it("emits a transcript update after successful compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await compactEmbeddedPiSessionDirect({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: "  /tmp/session.jsonl  ",
        workspaceDir: "/tmp",
        customInstructions: "focus on decisions",
      });

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile: "/tmp/session.jsonl" });
    } finally {
      cleanup();
    }
  });

  it("preserves tokensAfter when full-session context exceeds result.tokensBefore", async () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "user") {
        return 30;
      }
      if (role === "assistant") {
        return 20;
      }
      return 5;
    });
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 20,
      details: { ok: true },
    });

    const result = await runDirectCompaction();

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 20,
        tokensAfter: 30,
      },
    });
    expect(sessionHook("compact:after")?.context?.tokenCount).toBe(30);
  });

  it("treats pre-compaction token estimation failures as a no-op sanity check", async () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "assistant") {
        throw new Error("legacy message");
      }
      if (role === "user") {
        return 30;
      }
      return 5;
    });
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 20,
      details: { ok: true },
    });

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
    });

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensAfter: 30,
      },
    });
    expect(sessionHook("compact:after")?.context?.tokenCount).toBe(30);
  });

  it("skips sync in await mode when postCompactionForce is false", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: false,
        },
      },
    });

    const result = await compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        config: compactionConfig("await"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: TEST_SESSION_KEY,
      config: expect.any(Object),
    });
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("awaits post-compaction memory sync in await mode when postCompactionForce is true", async () => {
    let releaseSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const sync = vi.fn(() => syncGate);
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    let settled = false;

    const resultPromise = compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        config: compactionConfig("await"),
      }),
    );

    void resultPromise.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessionFiles: [TEST_SESSION_FILE],
      });
    });
    expect(settled).toBe(false);
    releaseSync?.();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(settled).toBe(true);
  });

  it("skips post-compaction memory sync when the mode is off", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    const result = await compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        config: compactionConfig("off"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("fires post-compaction memory sync without awaiting it in async mode", async () => {
    const sync = vi.fn(async () => {});
    let resolveManager: ((value: { manager: { sync: typeof sync } }) => void) | undefined;
    const managerGate = new Promise<{ manager: { sync: typeof sync } }>((resolve) => {
      resolveManager = resolve;
    });
    getMemorySearchManagerMock.mockImplementation(() => managerGate);
    let settled = false;

    const resultPromise = compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        config: compactionConfig("async"),
      }),
    );

    await vi.waitFor(() => {
      expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    });
    void resultPromise.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });
    expect(sync).not.toHaveBeenCalled();
    resolveManager?.({ manager: { sync } });
    await managerGate;
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessionFiles: [TEST_SESSION_FILE],
      });
    });
    const result = await resultPromise;
    expect(result.ok).toBe(true);
  });

  it("registers the Ollama api provider before compaction", async () => {
    resolveModelMock.mockReturnValue({
      model: {
        provider: "ollama",
        api: "ollama",
        id: "qwen3:8b",
        input: ["text"],
        baseUrl: "http://127.0.0.1:11434",
        headers: { Authorization: "Bearer ollama-cloud" },
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);
    sessionCompactImpl.mockImplementation(async () => {
      expect(getApiProvider("ollama" as Parameters<typeof getApiProvider>[0])).toBeDefined();
      return {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        details: { ok: true },
      };
    });

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
    });

    expect(result.ok).toBe(true);
  });

  it("aborts in-flight compaction when the caller abort signal fires", async () => {
    const controller = new AbortController();
    sessionCompactImpl.mockImplementationOnce(() => new Promise<never>(() => {}));

    const resultPromise = compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        abortSignal: controller.signal,
      }),
    );

    controller.abort(new Error("request timed out"));
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("request timed out");
    expect(sessionAbortCompactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("compactEmbeddedPiSession hooks (ownsCompaction engine)", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    resolveContextEngineMock.mockReset();
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
    });
    contextEngineCompactMock.mockReset();
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensAfter: 50 },
    });
    mockResolvedModel();
  });

  it("fires before_compaction with sentinel -1 and after_compaction on success", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedPiSession(
      wrappedCompactionArgs({
        messageChannel: "telegram",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: TEST_SESSION_FILE },
      expect.objectContaining({
        sessionKey: TEST_SESSION_KEY,
        messageProvider: "telegram",
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: -1,
        compactedCount: -1,
        tokenCount: 50,
        sessionFile: TEST_SESSION_FILE,
      },
      expect.objectContaining({
        sessionKey: TEST_SESSION_KEY,
        messageProvider: "telegram",
      }),
    );
  });

  it("emits a transcript update and post-compaction memory sync on the engine-owned path", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    try {
      const result = await compactEmbeddedPiSession(
        wrappedCompactionArgs({
          sessionFile: `  ${TEST_SESSION_FILE}  `,
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile: TEST_SESSION_FILE });
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessionFiles: [TEST_SESSION_FILE],
      });
    } finally {
      cleanup();
    }
  });

  it("does not fire after_compaction when compaction fails", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    contextEngineCompactMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
      result: undefined,
    });

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(false);
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not duplicate transcript updates or sync in the wrapper when the engine delegates compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });

    try {
      const result = await compactEmbeddedPiSession(
        wrappedCompactionArgs({
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("catches and logs hook exceptions without aborting compaction", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockRejectedValue(new Error("hook boom"));

    const result = await compactEmbeddedPiSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalled();
  });
});
