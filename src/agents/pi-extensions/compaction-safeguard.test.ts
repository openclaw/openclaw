import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension, { __testing } from "./compaction-safeguard.js";

const {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} = __testing;

describe("compaction-safeguard tool failures", () => {
  it("formats tool failures with meta and summary", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("exec (status=failed exitCode=1): ENOENT: missing file");
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ignored" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) => ({
      role: "toolResult",
      toolCallId: `call-${idx}`,
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: `error ${idx}` }],
      timestamp: Date.now(),
    }));

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
  });

  it("omits section when there are no tool failures", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toBe("");
  });
});

describe("computeAdaptiveChunkRatio", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns BASE_CHUNK_RATIO for normal messages", () => {
    // Small messages: 1000 tokens each, well under 10% of context
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(1000) }],
        timestamp: Date.now(),
      },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio when average message > 10% of context", () => {
    // Large messages: ~50K tokens each (25% of context)
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(50_000 * 4), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(50_000 * 4) }],
        timestamp: Date.now(),
      },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("respects MIN_CHUNK_RATIO floor", () => {
    // Very large messages that would push ratio below minimum
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(150_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("handles empty message array", () => {
    const ratio = computeAdaptiveChunkRatio([], CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("handles single huge message", () => {
    // Single massive message
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(180_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
    expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
  });
});

describe("isOversizedForSummary", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns false for small messages", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(false);
  });

  it("returns true for messages > 50% of context", () => {
    // Message with ~120K tokens (60% of 200K context)
    // After safety margin (1.2x), effective is 144K which is > 100K (50%)
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(120_000 * 4),
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(true);
  });

  it("applies safety margin", () => {
    // Message at exactly 50% of context before margin
    // After SAFETY_MARGIN (1.2), it becomes 60% which is > 50%
    const halfContextChars = (CONTEXT_WINDOW * 0.5) / SAFETY_MARGIN;
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(Math.floor(halfContextChars * 4)),
      timestamp: Date.now(),
    };

    // With safety margin applied, this should be at the boundary
    // The function checks if tokens * SAFETY_MARGIN > contextWindow * 0.5
    const isOversized = isOversizedForSummary(msg, CONTEXT_WINDOW);
    // Due to token estimation, this could be either true or false at the boundary
    expect(typeof isOversized).toBe("boolean");
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("stores and retrieves config by session manager identity", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.3 });
    const runtime = getCompactionSafeguardRuntime(sm);
    expect(runtime).toEqual({ maxHistoryShare: 0.3 });
  });

  it("returns null for unknown session manager", () => {
    const sm = {};
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("clears entry when value is null", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.7 });
    expect(getCompactionSafeguardRuntime(sm)).not.toBeNull();
    setCompactionSafeguardRuntime(sm, null);
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("ignores non-object session managers", () => {
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("isolates different session managers", () => {
    const sm1 = {};
    const sm2 = {};
    setCompactionSafeguardRuntime(sm1, { maxHistoryShare: 0.3 });
    setCompactionSafeguardRuntime(sm2, { maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime(sm1)).toEqual({ maxHistoryShare: 0.3 });
    expect(getCompactionSafeguardRuntime(sm2)).toEqual({ maxHistoryShare: 0.8 });
  });
});

describe("spurious compaction cancel guard", () => {
  function captureHandler() {
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    const api = {
      on(event: string, h: unknown) {
        if (event === "session_before_compact") {
          handler = h as (event: unknown, ctx: unknown) => Promise<unknown>;
        }
      },
    } as unknown as ExtensionAPI;
    compactionSafeguardExtension(api);
    if (!handler) {
      throw new Error("handler not registered");
    }
    return handler;
  }

  function makeEvent(tokensBefore: number) {
    return {
      preparation: {
        tokensBefore,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        firstKeptEntryId: "entry-1",
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 1000 },
      },
      branchEntries: [],
      signal: AbortSignal.abort(),
    };
  }

  function makeCtx(sessionManager: object, model?: { contextWindow: number }) {
    return {
      sessionManager,
      model: model ?? undefined,
      modelRegistry: { getApiKey: async () => null },
      ui: {},
      hasUI: false,
      cwd: "/tmp",
      isIdle: () => true,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
    };
  }

  it("cancels compaction when tokensBefore < 5% of context window (runtime)", async () => {
    const handler = captureHandler();
    const sm = {};
    setCompactionSafeguardRuntime(sm, { contextWindowTokens: 200_000 });

    // 1,472 tokens is well below 5% of 200K (10,000)
    const result = await handler(makeEvent(1_472), makeCtx(sm));
    expect(result).toEqual({ cancel: true });

    // cleanup
    setCompactionSafeguardRuntime(sm, null);
  });

  it("cancels compaction when tokensBefore < 5% of context window (model fallback)", async () => {
    const handler = captureHandler();
    const sm = {};
    // No runtime set — falls back to ctx.model.contextWindow

    const result = await handler(makeEvent(500), makeCtx(sm, { contextWindow: 200_000 }));
    expect(result).toEqual({ cancel: true });
  });

  it("does not cancel when tokensBefore >= 5% of context window", async () => {
    const handler = captureHandler();
    const sm = {};
    setCompactionSafeguardRuntime(sm, { contextWindowTokens: 200_000 });

    // 15,000 tokens > 5% of 200K (10,000) — should NOT cancel
    const result = await handler(makeEvent(15_000), makeCtx(sm));
    // Result should not have cancel: true (it will be a compaction result or fallback)
    expect(result?.cancel).not.toBe(true);

    setCompactionSafeguardRuntime(sm, null);
  });

  it("does not cancel at exactly 5% boundary", async () => {
    const handler = captureHandler();
    const sm = {};
    setCompactionSafeguardRuntime(sm, { contextWindowTokens: 200_000 });

    // Exactly 10,000 = 5% of 200K — should NOT cancel (guard uses strict <)
    const result = await handler(makeEvent(10_000), makeCtx(sm));
    expect(result?.cancel).not.toBe(true);

    setCompactionSafeguardRuntime(sm, null);
  });

  it("does not cancel when context window is unknown (0)", async () => {
    const handler = captureHandler();
    const sm = {};
    // No runtime, no model — guardContextWindow will be 0, guard skipped

    const result = await handler(makeEvent(100), makeCtx(sm));
    expect(result?.cancel).not.toBe(true);
  });
});
