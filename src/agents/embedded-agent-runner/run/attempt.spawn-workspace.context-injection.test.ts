import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { assembleHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import { limitHistoryTurns } from "../history.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { resolveAttemptBootstrapContext } from "./attempt-context-engine-helpers.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt-thread-helpers.js";

describe("embedded attempt context injection", () => {
  it.each([
    { name: "limited bootstrap", mode: "limited", contextMode: "full" },
    { name: "lightweight automation", mode: "none", contextMode: "lightweight" },
  ] as const)("skips context injection for completed $name turns", async (testCase) => {
    const hasCompletedBootstrapTurn = vi.fn(async () => true);
    const resolveBootstrapContextForRun = vi.fn(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    }));
    expect(
      await resolveAttemptBootstrapContext({
        contextInjectionMode: "continuation-skip",
        bootstrapMode: testCase.mode,
        bootstrapContextMode: testCase.contextMode,
        hasCompletedBootstrapTurn,
        resolveBootstrapContextForRun,
      }),
    ).toEqual({
      bootstrapFiles: [],
      contextFiles: [],
      isContinuationTurn: true,
      shouldRecordCompletedBootstrapTurn: false,
    });
    expect(hasCompletedBootstrapTurn).toHaveBeenCalledOnce();
    expect(resolveBootstrapContextForRun).not.toHaveBeenCalled();
  });

  it("filters no-op heartbeat pairs before history limiting and context-engine assembly", async () => {
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages,
      estimatedTokens: 1,
    }));
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "real question", timestamp: 1 } as AgentMessage,
      { role: "assistant", content: "real answer", timestamp: 2 } as unknown as AgentMessage,
      { role: "user", content: HEARTBEAT_PROMPT, timestamp: 3 } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Checking the heartbeat." },
          { type: "text", text: "HEARTBEAT_OK" },
        ],
        timestamp: 4,
      } as unknown as AgentMessage,
    ];

    const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
      sessionMessages,
      undefined,
      HEARTBEAT_PROMPT,
    );
    const limited = limitHistoryTurns(heartbeatFiltered, 1);
    await assembleHarnessContextEngine({
      contextEngine: {
        info: { id: "test", name: "Test", version: "0.0.1" },
        ingest: async () => ({ ingested: true }),
        compact: async () => ({ ok: false, compacted: false, reason: "unused" }),
        assemble,
      } satisfies ContextEngine,
      sessionId: "session",
      sessionKey: "agent:main:guildchat:dm:test-user",
      messages: limited,
      modelId: "gpt-test",
    });

    const assembleInput = assemble.mock.calls.at(0)?.[0] as
      | { messages?: AgentMessage[] }
      | undefined;
    const projectedMessages = assembleInput?.messages?.map((message) => ({
      role: message.role,
      content: (message as { content?: unknown }).content,
    }));
    expect(projectedMessages).toEqual([
      { role: "user", content: "real question" },
      { role: "assistant", content: "real answer" },
    ]);
  });

  it("records cache continuity without compaction", async () => {
    const sessionManager = { appendCustomEntryAsync: vi.fn(async () => undefined) };
    const appended = await appendAttemptCacheTtlIfNeeded({
      sessionManager,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });
    expect(appended).toBe(true);
    expect(sessionManager.appendCustomEntryAsync).toHaveBeenCalledWith("openclaw.cache-ttl", {
      timestamp: 123,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [],
    });
  });
});
