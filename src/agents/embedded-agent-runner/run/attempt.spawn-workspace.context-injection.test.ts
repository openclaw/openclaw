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
  it("skips context injection for completed limited bootstrap turns", async () => {
    const hasCompletedBootstrapTurn = vi.fn(async () => true);
    const resolveBootstrapContextForRun = vi.fn(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    }));
    expect(
      await resolveAttemptBootstrapContext({
        contextInjectionMode: "continuation-skip",
        bootstrapMode: "limited",
        bootstrapContextRunKind: "default",
        bootstrapContextMode: "full",
        deliversCompleteWorkspaceContext: false,
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

  it.each([
    {
      mode: "always",
      bootstrapMode: "none",
      runKind: "default",
      contextMode: "full",
      complete: true,
      expected: false,
    },
    {
      mode: "always",
      bootstrapMode: "full",
      runKind: "default",
      contextMode: "full",
      complete: true,
      expected: true,
    },
    {
      mode: "continuation-skip",
      bootstrapMode: "none",
      runKind: "cron",
      contextMode: "full",
      complete: true,
      expected: false,
    },
    {
      mode: "continuation-skip",
      bootstrapMode: "none",
      runKind: "heartbeat",
      contextMode: "full",
      complete: true,
      expected: false,
    },
    {
      mode: "continuation-skip",
      bootstrapMode: "none",
      runKind: "default",
      contextMode: "lightweight",
      complete: true,
      expected: false,
    },
    {
      mode: "continuation-skip",
      bootstrapMode: "limited",
      runKind: "default",
      contextMode: "full",
      complete: false,
      expected: false,
    },
    {
      mode: "never",
      bootstrapMode: "full",
      runKind: "default",
      contextMode: "full",
      complete: true,
      expected: false,
    },
  ] as const)(
    "completion eligibility: $mode / $bootstrapMode / $runKind / $contextMode",
    async (testCase) => {
      const result = await resolveAttemptBootstrapContext({
        contextInjectionMode: testCase.mode,
        bootstrapMode: testCase.bootstrapMode,
        bootstrapContextRunKind: testCase.runKind,
        bootstrapContextMode: testCase.contextMode,
        deliversCompleteWorkspaceContext: testCase.complete,
        hasCompletedBootstrapTurn: async () => false,
        resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      });
      expect(result.shouldRecordCompletedBootstrapTurn).toBe(testCase.expected);
    },
  );

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
