import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompactionInterceptRequest,
  CompactionInterceptResult,
  ContextEngine,
  ContextEngineInfo,
} from "../../context-engine/types.js";
import {
  getCompactionInterceptRuntime,
  setCompactionInterceptRuntime,
} from "./compaction-intercept-runtime.js";
import compactionInterceptExtension from "./compaction-intercept.js";

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function stubSessionManager(
  overrides: Partial<{
    sessionId: string;
    sessionFile: string | undefined;
  }> = {},
): ExtensionContext["sessionManager"] {
  const sessionFileResolved =
    "sessionFile" in overrides ? overrides.sessionFile : "/stub/session.jsonl";
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionDir: () => "/stub",
    getSessionId: () => overrides.sessionId ?? "stub-session-id",
    getSessionFile: () => sessionFileResolved as string,
    getLeafId: () => null,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

function makeEngine(
  info: ContextEngineInfo,
  interceptImpl?: (req: CompactionInterceptRequest) => Promise<CompactionInterceptResult>,
): ContextEngine {
  const engine: Partial<ContextEngine> = {
    info,
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async () => ({ messages: [], estimatedTokens: 0 })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
  };
  if (interceptImpl) {
    engine.interceptCompaction = vi.fn(interceptImpl);
  }
  return engine as ContextEngine;
}

function captureHandler(): CompactionHandler {
  let handler: CompactionHandler | undefined;
  const api = {
    on: vi.fn((event: string, h: CompactionHandler) => {
      if (event === "session_before_compact") handler = h;
    }),
  } as unknown as ExtensionAPI;
  compactionInterceptExtension(api);
  if (!handler) throw new Error("intercept extension did not register a handler");
  return handler;
}

function makeEvent(
  overrides: Partial<{
    firstKeptEntryId: string;
    tokensBefore: number;
  }> = {},
) {
  return {
    preparation: {
      firstKeptEntryId: overrides.firstKeptEntryId ?? "entry-keep-me",
      tokensBefore: overrides.tokensBefore ?? 232_000,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      fileOps: { read: [], edited: [], written: [] },
    },
    branchEntries: [],
    customInstructions: undefined,
    signal: new AbortController().signal,
  };
}

function makeCtx(
  sessionManager: ExtensionContext["sessionManager"],
  overrides: Partial<{
    contextWindow: number;
    tokens: number | null;
  }> = {},
) {
  // `"tokens" in overrides` distinguishes "explicitly set to null" from "not
  // overridden" — `??` would swallow an explicit null and substitute the
  // default, which breaks the null-tokens contract test.
  const tokensResolved = "tokens" in overrides ? overrides.tokens : 232_000;
  return {
    sessionManager,
    cwd: "/stub",
    getContextUsage: () => ({
      contextWindow: overrides.contextWindow ?? 258_000,
      tokens: tokensResolved,
      percent: 0.9,
    }),
  } as unknown as ExtensionContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compactionInterceptExtension", () => {
  it("returns undefined when no runtime is registered (no engine resolved)", async () => {
    const handler = captureHandler();
    // Use a fresh sessionManager identity that has no runtime entry.
    const ctx = makeCtx(stubSessionManager());
    const result = await handler(makeEvent(), ctx);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the engine does not implement interceptCompaction", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager();
    const engine = makeEngine(
      { id: "no-intercept", name: "No Intercept", interceptsCompaction: true },
      // intentionally not providing interceptImpl — method is undefined
    );
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const ctx = makeCtx(sm);
      const result = await handler(makeEvent(), ctx);
      expect(result).toBeUndefined();
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("returns { compaction } when engine handles the intercept (handled: true)", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager({ sessionId: "abc-123", sessionFile: "/x/session.jsonl" });
    const intercept = vi.fn(
      async (req: CompactionInterceptRequest): Promise<CompactionInterceptResult> => {
        expect(req.sessionId).toBe("abc-123");
        expect(req.sessionFile).toBe("/x/session.jsonl");
        expect(req.tokenBudget).toBe(258_000);
        expect(req.currentTokenCount).toBe(232_000);
        expect(req.firstKeptEntryId).toBe("entry-keep-me");
        expect(req.tokensBefore).toBe(232_000);
        expect(req.signal).toBeInstanceOf(AbortSignal);
        return {
          handled: true,
          summary: "LCM-produced summary text",
          firstKeptEntryId: req.firstKeptEntryId,
          tokensBefore: req.tokensBefore,
          tokensAfter: 80_000,
          details: { engine: "lcm", strategy: "intercept" },
        };
      },
    );
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true }, intercept);
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const ctx = makeCtx(sm);
      const result = await handler(makeEvent(), ctx);
      expect(intercept).toHaveBeenCalledOnce();
      expect(result).toEqual({
        compaction: {
          summary: "LCM-produced summary text",
          firstKeptEntryId: "entry-keep-me",
          tokensBefore: 232_000,
          details: { engine: "lcm", strategy: "intercept" },
        },
      });
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("returns undefined when the engine declines (handled: false)", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager();
    const intercept = vi.fn(
      async (): Promise<CompactionInterceptResult> => ({
        handled: false,
        reason: "session-ignored",
      }),
    );
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true }, intercept);
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const ctx = makeCtx(sm);
      const result = await handler(makeEvent(), ctx);
      expect(intercept).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("swallows thrown errors and returns undefined (engine bug must not break runtime)", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager();
    const intercept = vi.fn(async () => {
      throw new Error("kaboom");
    });
    const engine = makeEngine(
      { id: "lcm", name: "LCM", interceptsCompaction: true },
      intercept as (req: CompactionInterceptRequest) => Promise<CompactionInterceptResult>,
    );
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const ctx = makeCtx(sm);
      const result = await handler(makeEvent(), ctx);
      expect(intercept).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("propagates the AbortSignal from the event into the engine request", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager();
    const captured: { signal?: AbortSignal } = {};
    const intercept = vi.fn(
      async (req: CompactionInterceptRequest): Promise<CompactionInterceptResult> => {
        captured.signal = req.signal;
        return { handled: false, reason: "captured-signal" };
      },
    );
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true }, intercept);
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const controller = new AbortController();
      const event = makeEvent();
      // Override the event's signal field with our controller.
      (event as { signal: AbortSignal }).signal = controller.signal;
      const ctx = makeCtx(sm);
      await handler(event, ctx);
      expect(captured.signal).toBe(controller.signal);
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("bails (returns undefined) when getSessionFile() returns undefined", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager({ sessionFile: undefined });
    const intercept = vi.fn(async () => ({
      handled: true,
      summary: "should not be called",
      firstKeptEntryId: "entry-1",
      tokensBefore: 1,
    }));
    const engine = makeEngine(
      { id: "lcm", name: "LCM", interceptsCompaction: true },
      intercept as (req: CompactionInterceptRequest) => Promise<CompactionInterceptResult>,
    );
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const ctx = makeCtx(sm);
      const result = await handler(makeEvent(), ctx);
      expect(intercept).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("passes sessionKey from the runtime registry into the engine request", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager();
    let captured: CompactionInterceptRequest | undefined;
    const intercept = vi.fn(
      async (req: CompactionInterceptRequest): Promise<CompactionInterceptResult> => {
        captured = req;
        return { handled: false, reason: "captured" };
      },
    );
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true }, intercept);
    setCompactionInterceptRuntime(sm, {
      contextEngine: engine,
      sessionKey: "agent:main:subagent:abc123",
    });
    try {
      const ctx = makeCtx(sm);
      await handler(makeEvent(), ctx);
      expect(captured?.sessionKey).toBe("agent:main:subagent:abc123");
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("getContextUsage returning null tokens → currentTokenCount is undefined", async () => {
    const handler = captureHandler();
    const sm = stubSessionManager();
    let captured: CompactionInterceptRequest | undefined;
    const intercept = vi.fn(
      async (req: CompactionInterceptRequest): Promise<CompactionInterceptResult> => {
        captured = req;
        return { handled: false, reason: "captured" };
      },
    );
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true }, intercept);
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const ctx = makeCtx(sm, { tokens: null });
      await handler(makeEvent(), ctx);
      expect(captured?.currentTokenCount).toBeUndefined();
      expect(captured?.tokenBudget).toBe(258_000);
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });
});

describe("compaction-intercept-runtime", () => {
  it("set/get round-trip preserves contextEngine reference", () => {
    const sm = stubSessionManager();
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true });
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    try {
      const runtime = getCompactionInterceptRuntime(sm);
      expect(runtime?.contextEngine).toBe(engine);
    } finally {
      setCompactionInterceptRuntime(sm, null);
    }
  });

  it("setting null clears the registry entry", () => {
    const sm = stubSessionManager();
    const engine = makeEngine({ id: "lcm", name: "LCM", interceptsCompaction: true });
    setCompactionInterceptRuntime(sm, { contextEngine: engine });
    setCompactionInterceptRuntime(sm, null);
    expect(getCompactionInterceptRuntime(sm)).toBeNull();
  });

  it("returns null for unknown session managers", () => {
    expect(getCompactionInterceptRuntime(stubSessionManager())).toBeNull();
  });

  it("returns null for non-object inputs (defensive)", () => {
    expect(getCompactionInterceptRuntime(null)).toBeNull();
    expect(getCompactionInterceptRuntime(undefined)).toBeNull();
    expect(getCompactionInterceptRuntime("not-an-object")).toBeNull();
  });
});
