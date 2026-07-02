import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import { buildSessionContext } from "../session/session.js";
import type { SessionTreeEntry } from "../types.js";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, generateSummary } from "./compaction.js";

describe("generateSummary thinking options", () => {
  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
      expect(options?.reasoning).toBe("low");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });
});

describe("prepareCompaction", () => {
  function createHighUsageSmallTranscriptEntries(): SessionTreeEntry[] {
    return [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-06-17T08:45:00.000Z",
        message: { role: "user", content: "What do you see in your history?", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-06-17T08:45:10.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Stored." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          usage: {
            input: 625,
            output: 6,
            cacheRead: 172_928,
            cacheWrite: 0,
            totalTokens: 173_559,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ];
  }

  it("skips automatic no-op summaries when usage is high but transcript text is below the kept-tail budget", () => {
    const entries = createHighUsageSmallTranscriptEntries();

    const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);

    expect(preparation).toEqual({ ok: true, value: undefined });
  });

  it("forces manual preparation when usage is high but transcript text is below the kept-tail budget", () => {
    const entries = createHighUsageSmallTranscriptEntries();

    const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { force: true });

    expect(preparation).toEqual({
      ok: true,
      value: expect.objectContaining({
        firstKeptEntryId: "assistant-1",
        messagesToSummarize: entries.map((entry) =>
          entry.type === "message" ? entry.message : undefined,
        ),
        tokensBefore: 173_559,
        turnPrefixMessages: [],
      }),
    });
  });

  it("anchors a forced boundary on the assistant tool call, not a trailing tool result", () => {
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-06-17T08:45:00.000Z",
        message: { role: "user", content: "Read the notes file.", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-06-17T08:45:10.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "notes.md" } },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          usage: {
            input: 625,
            output: 6,
            cacheRead: 172_928,
            cacheWrite: 0,
            totalTokens: 173_559,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-06-17T08:45:11.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: [{ type: "text", text: "notes body" }],
          isError: false,
          timestamp: 3,
        },
      },
    ];

    const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { force: true });

    // Anchor must be the assistant that owns the tool call, never the trailing
    // tool result, or the rebuilt context would replay an orphaned tool result.
    expect(preparation).toEqual({
      ok: true,
      value: expect.objectContaining({ firstKeptEntryId: "assistant-1" }),
    });

    const compactedContext = buildSessionContext([
      ...entries,
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "tool-1",
        timestamp: "2026-06-17T08:45:20.000Z",
        summary: "Checkpoint of the file read.",
        firstKeptEntryId: "assistant-1",
        tokensBefore: 173_559,
      },
    ]);
    expect(compactedContext.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "toolResult",
    ]);
  });

  it("shows why the old empty-summary compaction replayed the whole transcript", () => {
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-06-17T08:45:00.000Z",
        message: { role: "user", content: "What do you see in your history?", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-06-17T08:45:10.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Stored." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          usage: {
            input: 625,
            output: 6,
            cacheRead: 172_928,
            cacheWrite: 0,
            totalTokens: 173_559,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ];

    const compactedContext = buildSessionContext([
      ...entries,
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "assistant-1",
        timestamp: "2026-06-17T08:45:20.000Z",
        summary: "No prior conversation content provided.",
        firstKeptEntryId: "user-1",
        tokensBefore: 173_559,
      },
    ]);
    expect(compactedContext.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
  });
});
