import { describe, expect, it, vi } from "vitest";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-boundary.js";

function createActiveSession(messages: AgentMessage[] = []) {
  const reset = vi.fn();
  const convertToLlm = vi.fn((input: AgentMessage[]) => input as never);
  const activeSession = {
    agent: {
      reset,
      state: { messages },
      convertToLlm,
    },
  } as unknown as Pick<AgentSession, "agent">;
  return { activeSession, convertToLlm, reset };
}

function createSessionManager(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof guardSessionManager> {
  return {
    getLeafEntry: () => undefined,
    ...overrides,
  } as unknown as ReturnType<typeof guardSessionManager>;
}

describe("prepareEmbeddedAttemptSessionBoundary", () => {
  it("resets restored state and preserves exact prompt bytes for raw model probes", async () => {
    const { activeSession, reset } = createActiveSession();
    const setActiveSessionSystemPrompt = vi.fn();

    const boundary = prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "exact probe" },
      getUserTranscriptContexts: () => undefined,
      isOpenAIResponsesApi: false,
      isRawModelRun: true,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt,
      transcriptPolicy: { repairToolUseResultPairing: false },
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "exact probe" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).toHaveBeenCalledOnce();
    expect(setActiveSessionSystemPrompt).toHaveBeenCalledWith("");
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("exact probe");
    expect((converted[0] as { content?: unknown }).content).not.toContain("Conversation info");
  });

  it("applies the prepared current-turn timestamp at the LLM boundary", async () => {
    const { activeSession } = createActiveSession();
    const preparedTimestamp = 1_717_570_800_000;
    const boundary = prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        config: { agents: { defaults: { userTimezone: "UTC" } } },
        prompt: "Current ask",
        trigger: "user",
      },
      getUserTranscriptContexts: () => undefined,
      isOpenAIResponsesApi: false,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
      transcriptPolicy: { repairToolUseResultPairing: false },
    });
    boundary.setCurrentUserTimestampOverride({
      timestamp: preparedTimestamp,
      text: "Current ask",
    });

    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "Current ask" }],
        timestamp: preparedTimestamp + 60_000,
      },
    ]);

    expect((converted[0] as { content?: unknown }).content).toBe(
      `${buildTimestampPrefix(new Date(preparedTimestamp), { timezone: "UTC" })}Current ask`,
    );
  });

  it("projects the exact persisted sender row for the active user turn", async () => {
    const runtimeMessage = {
      role: "user",
      content: [{ type: "text", text: "The launch is Friday" }],
      timestamp: 1,
    } as AgentMessage;
    const transcriptMessage = {
      role: "user",
      content: "The launch is Friday",
      timestamp: 1,
      __openclaw: { senderId: "alice-id", senderName: "Alice" },
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "The launch is Friday", trigger: "user" },
      getUserTranscriptContexts: () => [{ runtimeMessage, transcriptMessage }],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
      isOpenAIResponsesApi: false,
      transcriptPolicy: { repairToolUseResultPairing: false },
    });

    const converted = await activeSession.agent.convertToLlm([runtimeMessage]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name": "Alice"');
  });

  it("retains sender projection for earlier in-memory turns after a queued turn", async () => {
    const initialRuntime = {
      role: "user",
      content: [{ type: "text", text: "The launch is Friday" }],
      timestamp: 1,
    } as AgentMessage;
    const queuedRuntime = {
      role: "user",
      content: [{ type: "text", text: "I can present it" }],
      timestamp: 2,
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "The launch is Friday", trigger: "user" },
      getUserTranscriptContexts: () => [
        {
          runtimeMessage: initialRuntime,
          transcriptMessage: {
            role: "user",
            content: "The launch is Friday",
            timestamp: 1,
            __openclaw: { senderId: "alice-id", senderName: "Alice" },
          } as AgentMessage,
        },
        {
          runtimeMessage: queuedRuntime,
          transcriptMessage: {
            role: "user",
            content: "I can present it",
            timestamp: 2,
            __openclaw: { senderId: "bob-id", senderName: "Bob" },
          } as AgentMessage,
        },
      ],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
      isOpenAIResponsesApi: false,
      transcriptPolicy: { repairToolUseResultPairing: false },
    });

    const converted = await activeSession.agent.convertToLlm([initialRuntime, queuedRuntime]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name": "Alice"');
    expect((converted[1] as { content?: unknown }).content).toContain('"name": "Bob"');
  });

  it("reserves exact pairings before matching duplicate timestamp and text", async () => {
    const firstRuntime = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    } as AgentMessage;
    const secondRuntime = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "same", trigger: "user" },
      getUserTranscriptContexts: () => [
        {
          runtimeMessage: secondRuntime,
          transcriptMessage: {
            role: "user",
            content: "same",
            timestamp: 1,
            __openclaw: { senderName: "Bob" },
          } as AgentMessage,
        },
        {
          runtimeMessage: firstRuntime,
          transcriptMessage: {
            role: "user",
            content: "same",
            timestamp: 1,
            __openclaw: { senderName: "Alice" },
          } as AgentMessage,
        },
      ],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
      isOpenAIResponsesApi: false,
      transcriptPolicy: { repairToolUseResultPairing: false },
    });

    const converted = await activeSession.agent.convertToLlm([firstRuntime, secondRuntime]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name": "Alice"');
    expect((converted[1] as { content?: unknown }).content).toContain('"name": "Bob"');
  });

  it("repairs an orphaned user leaf before rebuilding active session messages", () => {
    const repairedMessages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "repaired" }], timestamp: 2 },
    ];
    const { activeSession } = createActiveSession([
      { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
    ]);
    const branch = vi.fn();
    const clearNextUserMessagePersistenceSuppression = vi.fn();
    const onUserMessagePersistenceInvalidated = vi.fn();
    const sessionManager = createSessionManager({
      getLeafEntry: () => ({
        id: "user-leaf",
        parentId: "parent-entry",
        type: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
      branch,
      clearNextUserMessagePersistenceSuppression,
      buildSessionContext: () => ({ messages: repairedMessages }),
    });

    const boundary = prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        onUserMessagePersistenceInvalidated,
        prompt: "new",
        trigger: "user",
      },
      getUserTranscriptContexts: () => undefined,
      isOpenAIResponsesApi: false,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager,
      setActiveSessionSystemPrompt: vi.fn(),
      transcriptPolicy: { repairToolUseResultPairing: false },
    });

    expect(boundary.orphanRepair?.removeLeaf).toBe(true);
    expect(branch).toHaveBeenCalledWith("parent-entry");
    expect(clearNextUserMessagePersistenceSuppression).toHaveBeenCalledOnce();
    expect(onUserMessagePersistenceInvalidated).toHaveBeenCalledOnce();
    expect(activeSession.agent.state.messages).toBe(repairedMessages);
  });

  it("applies repair to orphaned tool_use when policy is enabled", () => {
    // Simulate original messages with an orphaned tool_use (no matching toolResult)
    const rawMessages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "List files" }], timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check the directory." },
          {
            type: "toolCall" as const,
            id: "toolu_repair_test",
            name: "list_files",
            input: { path: "." },
          },
        ],
        provider: "anthropic" as const,
        model: "sonnet-4.6" as const,
        stopReason: "toolUse" as const,
        timestamp: 2,
      },
    ] as unknown as AgentMessage[];
    const { activeSession } = createActiveSession([]);
    const onUserMessagePersistenceInvalidated = vi.fn();
    const sessionManager = createSessionManager({
      getLeafEntry: () => ({
        id: "user-leaf",
        parentId: "parent-entry",
        type: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
      branch: vi.fn(),
      clearNextUserMessagePersistenceSuppression: vi.fn(),
      buildSessionContext: () => ({ messages: rawMessages }),
    });

    prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        onUserMessagePersistenceInvalidated,
        prompt: "new",
        trigger: "user",
      },
      isOpenAIResponsesApi: false,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager,
      setActiveSessionSystemPrompt: vi.fn(),
      transcriptPolicy: { repairToolUseResultPairing: true },
      getUserTranscriptContexts: () => undefined,
    });

    // With repair enabled, the orphaned tool_use should be paired with a synthetic toolResult
    expect(activeSession.agent.state.messages).not.toBe(rawMessages);
    const toolResults = (activeSession.agent.state.messages as AgentMessage[]).filter(
      (m) => (m as { role?: string }).role === "toolResult",
    );
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { toolCallId?: string }).toolCallId).toBe("toolu_repair_test");
    expect((toolResults[0] as { isError?: boolean }).isError).toBe(true);
  });
});
