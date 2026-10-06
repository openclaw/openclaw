import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { resolveWorkspaceBootstrapRouting } from "../../bootstrap-routing.js";
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

  it("records completion for a workspace whose onboarding is already done", async () => {
    // A completed workspace resolves bootstrapMode "none" on every turn, which on
    // its own would make the continuation-skip marker impossible to earn.
    const result = await resolveAttemptBootstrapContext({
      contextInjectionMode: "continuation-skip",
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      bootstrapMode: "none",
      deliversCompleteWorkspaceContext: true,
      hasCompletedBootstrapTurn: async () => false,
      resolveBootstrapContextForRun: async () => ({
        bootstrapFiles: [{ name: "AGENTS.md", content: "workspace rules" }],
        contextFiles: [{ path: "AGENTS.md", content: "workspace rules" }],
      }),
    });

    expect(result.isContinuationTurn).toBe(false);
    expect(result.shouldRecordCompletedBootstrapTurn).toBe(true);
  });

  it("does not record a completion marker for the default always-injection mode", async () => {
    // "always" never reads the marker back, so a setup-complete workspace must not
    // start appending one transcript entry per session under it.
    const result = await resolveAttemptBootstrapContext({
      contextInjectionMode: "always",
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      bootstrapMode: "none",
      deliversCompleteWorkspaceContext: true,
      hasCompletedBootstrapTurn: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    });

    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
  });

  it("does not let a cron maintenance turn record bootstrap completion", async () => {
    const result = await resolveAttemptBootstrapContext({
      contextInjectionMode: "continuation-skip",
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "cron",
      bootstrapMode: "none",
      deliversCompleteWorkspaceContext: true,
      hasCompletedBootstrapTurn: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    });

    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
  });

  it("withholds the marker from a turn that did not deliver every workspace file", async () => {
    // A guarded-read placeholder reports the fault instead of the file, so certifying
    // this turn would let the next continuation skip content the session never saw.
    const result = await resolveAttemptBootstrapContext({
      contextInjectionMode: "continuation-skip",
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      bootstrapMode: "none",
      deliversCompleteWorkspaceContext: false,
      hasCompletedBootstrapTurn: async () => false,
      resolveBootstrapContextForRun: async () => ({
        bootstrapFiles: [{ name: "AGENTS.md", content: "workspace rules" }],
        contextFiles: [{ path: "AGENTS.md", content: "workspace rules" }],
      }),
    });

    expect(result.isContinuationTurn).toBe(false);
    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
  });

  it("carries a completed workspace routing decision into marker eligibility", async () => {
    // The same inputs attempt preparation supplies once workspace setup is done:
    // nothing pending, a primary interactive run, canonical workspace.
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: async () => false,
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    const result = await resolveAttemptBootstrapContext({
      contextInjectionMode: "continuation-skip",
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      bootstrapMode: routing.bootstrapMode,
      deliversCompleteWorkspaceContext: routing.deliversCompleteWorkspaceContext,
      hasCompletedBootstrapTurn: async () => false,
      resolveBootstrapContextForRun: async () => ({
        bootstrapFiles: [{ name: "AGENTS.md", content: "workspace instructions" }],
        contextFiles: [{ path: "AGENTS.md", content: "workspace instructions" }],
      }),
    });

    expect(routing.bootstrapMode).toBe("none");
    // The turn really did carry the workspace files, and now it earns the marker
    // that lets the next continuation skip them.
    expect(result.contextFiles).toEqual([{ path: "AGENTS.md", content: "workspace instructions" }]);
    expect(result.shouldRecordCompletedBootstrapTurn).toBe(true);
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
