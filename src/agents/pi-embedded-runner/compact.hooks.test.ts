import { beforeEach, describe, expect, it, vi } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

const {
  hookRunner,
  ensureRuntimePluginsLoaded,
  resolveModelMock,
  sessionCompactImpl,
  triggerInternalHook,
  sanitizeSessionHistoryMock,
  contextEngineCompactMock,
} = vi.hoisted(() => ({
  hookRunner: {
    hasHooks: vi.fn(),
    runBeforeCompaction: vi.fn(),
    runAfterCompaction: vi.fn(),
  },
  ensureRuntimePluginsLoaded: vi.fn(),
  resolveModelMock: vi.fn(() => ({
    model: { provider: "openai", api: "responses", id: "fake", input: [] },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  })),
  sessionCompactImpl: vi.fn(async () => ({
    summary: "summary",
    firstKeptEntryId: "entry-1",
    tokensBefore: 120,
    details: { ok: true },
  })),
  triggerInternalHook: vi.fn(),
  sanitizeSessionHistoryMock: vi.fn(async (params: { messages: unknown[] }) => params.messages),
  contextEngineCompactMock: vi.fn(async () => ({
    ok: true as boolean,
    compacted: true as boolean,
    reason: undefined as string | undefined,
    result: { summary: "engine-summary", tokensAfter: 50 } as
      | { summary: string; tokensAfter: number }
      | undefined,
  })),
}));

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

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
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
    estimateTokens: vi.fn(() => 10),
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
  resolveContextEngine: vi.fn(async () => ({
    info: { ownsCompaction: true },
    compact: contextEngineCompactMock,
  })),
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
  createOpenClawCodingTools: vi.fn(() => []),
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
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
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
    resolveModelMock.mockReset();
    resolveModelMock.mockReturnValue({
      model: { provider: "openai", api: "responses", id: "fake", input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
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
    unregisterApiProviders(getCustomApiRegistrySourceId("ollama"));
  });

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

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
    });

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
});

describe("compactEmbeddedPiSession hooks (ownsCompaction engine)", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    contextEngineCompactMock.mockReset();
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensAfter: 50 },
    });
    resolveModelMock.mockReset();
    resolveModelMock.mockReturnValue({
      model: { provider: "openai", api: "responses", id: "fake", input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
  });

  it("fires before_compaction with sentinel -1 and after_compaction on success", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedPiSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      customInstructions: "focus on decisions",
      enqueue: (task) => task(),
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: "/tmp/session.jsonl" },
      expect.objectContaining({
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: -1,
        compactedCount: -1,
        tokenCount: 50,
        sessionFile: "/tmp/session.jsonl",
      },
      expect.objectContaining({
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
      }),
    );
  });

  it("does not fire after_compaction when compaction fails", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    contextEngineCompactMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
      result: undefined,
    });

    const result = await compactEmbeddedPiSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
      enqueue: (task) => task(),
    });

    expect(result.ok).toBe(false);
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
  });

  it("catches and logs hook exceptions without aborting compaction", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockRejectedValue(new Error("hook boom"));

    const result = await compactEmbeddedPiSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
      enqueue: (task) => task(),
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalled();
  });
});
