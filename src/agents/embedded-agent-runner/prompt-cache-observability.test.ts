import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPromptCacheObservation,
  collectPromptCacheToolNames,
  completePromptCacheObservation,
  describeSystemPromptDigestDrift,
  resetPromptCacheObservabilityForTest,
} from "./prompt-cache-observability.js";

describe("prompt cache observability", () => {
  beforeEach(() => {
    resetPromptCacheObservabilityForTest();
  });

  it("collects trimmed tool names only", () => {
    expect(
      collectPromptCacheToolNames([{ name: " read " }, { name: "" }, {}, { name: "write" }]),
    ).toEqual(["read", "write"]);
  });

  it("tracks cache-relevant changes and reports a real cache-read drop", () => {
    const first = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });

    expect(first.changes).toBeNull();
    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 8_000 },
      }),
    ).toBeNull();

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read", "write"],
    });

    expect(second.changes?.map((change) => change.code)).toEqual([
      "cacheRetention",
      "transport",
      "systemPrompt",
    ]);

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        { code: "cacheRetention", detail: "long -> short" },
        { code: "transport", detail: "sse -> websocket" },
        { code: "systemPrompt", detail: "system prompt digest changed" },
      ],
    });
  });

  it("suppresses cache-break events for small drops", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 5_000 },
    });

    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        usage: { cacheRead: 4_600 },
      }),
    ).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 8_000 },
    });

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["write", "read"],
    });

    expect(second.changes).toBeNull();
  });

  it("tracks recurring prompt-cache affinity across rotating session ids", () => {
    beginPromptCacheObservation({
      sessionId: "isolated-run-1",
      promptCacheKey: "openclaw-cron-stable-cache-key",
      sessionKey: "agent:cron:run:isolated-run-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "isolated-run-1",
      promptCacheKey: "openclaw-cron-stable-cache-key",
      sessionKey: "agent:cron:run:isolated-run-1",
      usage: { cacheRead: 8_000 },
    });

    const nextRun = beginPromptCacheObservation({
      sessionId: "isolated-run-2",
      promptCacheKey: "openclaw-cron-stable-cache-key",
      sessionKey: "agent:cron:run:isolated-run-2",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(nextRun.previousCacheRead).toBe(8_000);
    expect(nextRun.changes).toBeNull();
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    beginPromptCacheObservation({
      sessionId: "session-0",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-0",
      usage: { cacheRead: 8_000 },
    });

    for (let index = 1; index <= 513; index += 1) {
      beginPromptCacheObservation({
        sessionId: `session-${index}`,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        streamStrategy: "boundary-aware:openai-responses",
        systemPrompt: `stable system ${index}`,
        toolNames: ["read"],
      });
    }

    const restarted = beginPromptCacheObservation({
      sessionId: "session-0",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(restarted.previousCacheRead).toBeNull();
    expect(restarted.changes).toBeNull();
  });

  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      usage: { cacheRead: 8_000 },
    });

    beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
      }),
    ).toBeNull();

    const resumed = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
    });

    expect(resumed.previousCacheRead).toBe(8_000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: null,
    });
  });
});

describe("describeSystemPromptDigestDrift", () => {
  beforeEach(() => {
    resetPromptCacheObservabilityForTest();
  });

  it("returns null when no changes are present", () => {
    expect(
      describeSystemPromptDigestDrift({
        changes: null,
        provider: "openai",
        modelId: "gpt-5.4",
        streamStrategy: "boundary-aware:openai-responses",
      }),
    ).toBeNull();
  });

  it("returns null when changes do not include systemPrompt", () => {
    expect(
      describeSystemPromptDigestDrift({
        changes: [{ code: "tools", detail: "5 -> 6 tools" }],
        provider: "openai",
        modelId: "gpt-5.4",
        streamStrategy: "boundary-aware:openai-responses",
      }),
    ).toBeNull();
  });

  it("returns a diagnostic string when systemPrompt change is reported", () => {
    const message = describeSystemPromptDigestDrift({
      changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      streamStrategy: "boundary-aware:anthropic-messages",
    });
    expect(message).not.toBeNull();
    expect(message).toContain("system prompt digest changed across turns");
    expect(message).toContain("anthropic/claude-opus-4-6");
    expect(message).toContain("OPENCLAW_CACHE_TRACE");
  });

  it("flags cross-turn system prompt drift via begin observation", () => {
    const first = beginPromptCacheObservation({
      sessionId: "session-drift",
      sessionKey: "agent:main",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:anthropic-messages",
      transport: "sse",
      systemPrompt: "stable system + [Bootstrap truncation warning] AGENTS.md was truncated.",
      toolNames: ["read", "write"],
    });
    expect(first.changes).toBeNull();
    expect(
      describeSystemPromptDigestDrift({
        changes: first.changes,
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        streamStrategy: "boundary-aware:anthropic-messages",
      }),
    ).toBeNull();

    completePromptCacheObservation({
      sessionId: "session-drift",
      sessionKey: "agent:main",
      usage: { cacheRead: 16_000 },
    });

    // Simulate the historical "once" mode bug: turn 1 had a warning block,
    // turn 2 silently drops it because seenSignatures gates the warning. Our
    // observability layer must surface this on the first regression turn,
    // not wait for a cacheRead drop.
    const second = beginPromptCacheObservation({
      sessionId: "session-drift",
      sessionKey: "agent:main",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:anthropic-messages",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });
    expect(second.changes).not.toBeNull();
    expect(second.changes?.some((change) => change.code === "systemPrompt")).toBe(true);
    const diagnostic = describeSystemPromptDigestDrift({
      changes: second.changes,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      streamStrategy: "boundary-aware:anthropic-messages",
    });
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toContain("system prompt digest changed across turns");
  });
});
