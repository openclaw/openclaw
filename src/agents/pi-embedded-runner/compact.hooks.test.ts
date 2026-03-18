import { getApiProvider, unregisterApiProviders } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCustomApiRegistrySourceId } from "../custom-api-registry.js";
import {
  contextEngineCompactMock,
  createOpenClawCodingToolsMock,
  ensureRuntimePluginsLoaded,
  estimateTokensMock,
  getMemorySearchManagerMock,
  hookRunner,
  loadCompactHooksHarness,
  resolveContextEngineMock,
  resolveMemorySearchConfigMock,
  resolveModelMock,
  resolveSessionAgentIdMock,
  sanitizeSessionHistoryMock,
  sessionAbortCompactionMock,
  sessionCompactImpl,
  triggerInternalHook,
} from "./compact.hooks.harness.js";

let compactEmbeddedPiSessionDirect: typeof import("./compact.js").compactEmbeddedPiSessionDirect;
let compactEmbeddedPiSession: typeof import("./compact.js").compactEmbeddedPiSession;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const TEST_SESSION_FILE = "/tmp/session.jsonl";
const TEST_WORKSPACE_DIR = "/tmp";
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";
type SessionHookEvent = {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
};
type PostCompactionSyncParams = {
  reason: string;
  sessionFiles: string[];
};
type PostCompactionSync = (params?: unknown) => Promise<void>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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

const sessionHook = (action: string): SessionHookEvent | undefined =>
  triggerInternalHook.mock.calls.find((call) => {
    const event = call[0] as SessionHookEvent | undefined;
    return event?.type === "session" && event.action === action;
  })?.[0] as SessionHookEvent | undefined;

beforeEach(async () => {
  const loaded = await loadCompactHooksHarness();
  compactEmbeddedPiSessionDirect = loaded.compactEmbeddedPiSessionDirect;
  compactEmbeddedPiSession = loaded.compactEmbeddedPiSession;
  onSessionTranscriptUpdate = loaded.onSessionTranscriptUpdate;
});

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
        sessionFile: "/tmp/session.jsonl",
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
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    const syncRelease = createDeferred<void>();
    const sync = vi.fn<PostCompactionSync>(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
      await syncRelease.promise;
    });
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
    await expect(syncStarted.promise).resolves.toEqual({
      reason: "post-compaction",
      sessionFiles: [TEST_SESSION_FILE],
    });
    expect(settled).toBe(false);
    syncRelease.resolve(undefined);
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
    const sync = vi.fn<PostCompactionSync>(async () => {});
    const managerRequested = createDeferred<void>();
    const managerGate = createDeferred<{ manager: { sync: PostCompactionSync } }>();
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    sync.mockImplementation(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
    });
    getMemorySearchManagerMock.mockImplementation(async () => {
      managerRequested.resolve(undefined);
      return await managerGate.promise;
    });
    let settled = false;

    const resultPromise = compactEmbeddedPiSessionDirect(
      directCompactionArgs({
        config: compactionConfig("async"),
      }),
    );

    await managerRequested.promise;
    void resultPromise.then(() => {
      settled = true;
    });
    await resultPromise;
    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    managerGate.resolve({ manager: { sync } });
    await expect(syncStarted.promise).resolves.toEqual({
      reason: "post-compaction",
      sessionFiles: [TEST_SESSION_FILE],
    });
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
