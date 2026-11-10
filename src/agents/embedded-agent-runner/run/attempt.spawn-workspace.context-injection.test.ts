import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { assembleHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import { limitHistoryTurns } from "../history.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt-thread-helpers.js";

describe("embedded attempt context injection", () => {
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

    expect(assemble.mock.calls[0]?.[0].messages).toMatchObject([
      { role: "user", content: "real question" },
      { role: "assistant", content: "real answer" },
    ]);
  });

  it("records cache continuity without compaction", async () => {
    const sessionManager = { appendCustomEntryAsync: vi.fn(async () => undefined) };
    using _ = vi.spyOn(Date, "now").mockReturnValueOnce(123);
    await appendAttemptCacheTtlIfNeeded({
      sessionManager,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
    });
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
