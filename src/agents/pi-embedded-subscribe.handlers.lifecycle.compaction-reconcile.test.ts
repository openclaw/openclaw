import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
import { createEmbeddedPiSessionEventHandler } from "./pi-embedded-subscribe.handlers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function createLifecycleContext(params: {
  storePath: string;
  sessionKey: string;
  initialCount: number;
  agentId?: string;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    params: {
      runId: "run-lifecycle-test",
      session: { messages: [] } as never,
      config: { session: { store: params.storePath } } as never,
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      agentId: params.agentId ?? "test-agent",
      onAgentEvent: undefined,
    },
    state: {
      assistantTexts: [],
      toolMetas: [],
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      deltaBuffer: "",
      blockBuffer: "",
      blockState: { thinking: false, final: false, inlineCode: {} as never },
      partialBlockState: { thinking: false, final: false, inlineCode: {} as never },
      emittedAssistantUpdate: false,
      reasoningMode: "off",
      includeReasoning: false,
      shouldEmitPartialReplies: true,
      streamReasoning: false,
      assistantMessageIndex: 0,
      lastAssistantTextMessageIndex: -1,
      assistantTextBaseline: 0,
      suppressBlockChunks: false,
      compactionInFlight: false,
      pendingCompactionRetry: 0,
      compactionRetryPromise: null,
      unsubscribed: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
      messagingToolSentMediaUrls: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      successfulCronAdds: 0,
      pendingMessagingMediaUrls: new Map(),
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
    } as never,
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    blockChunker: null,
    noteLastAssistant: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    stripBlockTags: vi.fn((text: string) => text),
    emitBlockChunk: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    emitReasoningStream: vi.fn(),
    consumeReplyDirectives: vi.fn(),
    consumePartialReplyDirectives: vi.fn(),
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    finalizeAssistantTexts: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    recordAssistantUsage: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    getUsageTotals: vi.fn(),
    getCompactionCount: () => compactionCount,
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("createEmbeddedPiSessionEventHandler compaction reconciliation", () => {
  it("reconciles sessions.json on routed auto_compaction_end success", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-compaction-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const ctx = createLifecycleContext({
      storePath,
      sessionKey,
      initialCount: 1,
    });
    const handleEvent = createEmbeddedPiSessionEventHandler(ctx);

    handleEvent({ type: "auto_compaction_start" });
    expect(ctx.state.compactionInFlight).toBe(true);

    handleEvent({
      type: "auto_compaction_end",
      willRetry: false,
      aborted: false,
      result: { kept: 12 },
    });

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(ctx.getCompactionCount()).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });
});
