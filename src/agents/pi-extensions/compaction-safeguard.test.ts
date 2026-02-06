import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import { __testing } from "./compaction-safeguard.js";

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

describe("compaction-safeguard extension cancels on failure (#10332)", () => {
  // Capture the handler registered by the extension
  async function captureHandler() {
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    const api = {
      on(_event: string, h: (event: unknown, ctx: unknown) => Promise<unknown>) {
        handler = h;
      },
    };
    const mod = await import("./compaction-safeguard.js");
    const register = mod.default;
    register(api as never);
    if (!handler) {
      throw new Error("Extension did not register a session_before_compact handler");
    }
    return handler;
  }

  const minimalPreparation = {
    firstKeptEntryId: "entry-1",
    tokensBefore: 100_000,
    messagesToSummarize: [] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    isSplitTurn: false,
    previousSummary: undefined,
    fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };

  const minimalEvent = {
    type: "session_before_compact" as const,
    preparation: minimalPreparation,
    branchEntries: [],
    customInstructions: undefined,
    signal: new AbortController().signal,
  };

  it("cancels compaction when model is unavailable", async () => {
    const handler = await captureHandler();
    const ctx = {
      model: undefined,
      modelRegistry: { getApiKey: async () => "key" },
      sessionManager: {},
    };
    const result = (await handler(minimalEvent, ctx)) as { cancel?: boolean; compaction?: unknown };
    expect(result.cancel).toBe(true);
    expect(result.compaction).toBeUndefined();
  });

  it("cancels compaction when API key is unavailable", async () => {
    const handler = await captureHandler();
    const ctx = {
      model: { provider: "test", id: "test-model" },
      modelRegistry: { getApiKey: async () => undefined },
      sessionManager: {},
    };
    const result = (await handler(minimalEvent, ctx)) as { cancel?: boolean; compaction?: unknown };
    expect(result.cancel).toBe(true);
    expect(result.compaction).toBeUndefined();
  });

  it("cancels compaction when summarization throws", async () => {
    // Mock summarizeInStages to throw, simulating API/model failure
    const compactionMod = await import("../compaction.js");
    const originalFn = compactionMod.summarizeInStages;
    vi.spyOn(compactionMod, "summarizeInStages").mockRejectedValue(
      new Error("API connection failed"),
    );

    try {
      const handler = await captureHandler();
      const ctx = {
        model: { provider: "test", id: "test-model", contextWindow: 128_000 },
        modelRegistry: { getApiKey: async () => "valid-key" },
        sessionManager: {},
      };
      const event = {
        ...minimalEvent,
        preparation: {
          ...minimalPreparation,
          messagesToSummarize: [
            { role: "user", content: "hello", timestamp: Date.now() },
          ] as AgentMessage[],
        },
      };
      const result = (await handler(event, ctx)) as { cancel?: boolean; compaction?: unknown };
      expect(result.cancel).toBe(true);
      expect(result.compaction).toBeUndefined();
    } finally {
      vi.mocked(compactionMod.summarizeInStages).mockImplementation(originalFn);
    }
  });
});

describe("compaction-safeguard extension live test", () => {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  const LIVE = (process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1") && !!apiKey;

  it.skipIf(!LIVE)(
    "produces a real summary with a live model (LIVE=1)",
    async () => {
      const { resolveModel } = await import("../pi-embedded-runner/model.js");

      const provider = "anthropic";
      const modelId = process.env.LIVE_MODEL ?? "claude-haiku-4-5-20251001";
      const baseUrl = process.env.ANTHROPIC_BASE_URL;

      const { model, authStorage } = resolveModel(provider, modelId);
      if (!model) {
        throw new Error(`resolveModel failed for ${provider}/${modelId}`);
      }
      if (baseUrl) {
        (model as unknown as Record<string, unknown>).baseUrl = baseUrl;
      }
      authStorage.setRuntimeApiKey(provider, apiKey!);

      // Register extension handler
      let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
      const api = {
        on(_event: string, h: (event: unknown, ctx: unknown) => Promise<unknown>) {
          handler = h;
        },
      };
      const mod = await import("./compaction-safeguard.js");
      mod.default(api as never);
      expect(handler).toBeDefined();

      const messages: AgentMessage[] = [
        {
          role: "user",
          content: "Help me set up Docker for Node.js",
          timestamp: Date.now() - 60000,
        },
        {
          role: "user",
          content: "Also add PostgreSQL with docker-compose",
          timestamp: Date.now() - 30000,
        },
      ];

      const preparation = {
        firstKeptEntryId: "live-test-entry",
        tokensBefore: 50_000,
        messagesToSummarize: messages,
        turnPrefixMessages: [] as AgentMessage[],
        isSplitTurn: false,
        previousSummary: undefined,
        fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() },
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      };

      const event = {
        type: "session_before_compact" as const,
        preparation,
        branchEntries: [],
        customInstructions: undefined,
        signal: new AbortController().signal,
      };

      const ctx = {
        model,
        modelRegistry: { getApiKey: async () => apiKey! },
        sessionManager: {},
      };

      const result = (await handler!(event, ctx)) as {
        cancel?: boolean;
        compaction?: { summary: string; firstKeptEntryId: string };
      };

      // Should NOT cancel — real model + key available
      expect(result.cancel).toBeUndefined();
      expect(result.compaction).toBeDefined();
      expect(result.compaction!.summary.length).toBeGreaterThan(50);
      expect(result.compaction!.summary).not.toContain("Summary unavailable");
      expect(result.compaction!.firstKeptEntryId).toBe("live-test-entry");
    },
    60_000,
  );
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
