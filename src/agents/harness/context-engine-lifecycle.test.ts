import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import { runContextEngineMaintenance } from "../pi-embedded-runner/context-engine-maintenance.js";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
  runHarnessContextEngineMaintenance,
} from "./context-engine-lifecycle.js";

vi.mock("../pi-embedded-runner/context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: vi.fn(async () => ({
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
  })),
}));

function textMessage(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function runtimeContextMessage(content: string, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content,
    display: false,
    details: { source: "openclaw-runtime-context" },
    timestamp,
  } as AgentMessage;
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: { id: "test", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    ...overrides,
  };
}

type HarnessMaintenanceParams = Parameters<typeof runHarnessContextEngineMaintenance>[0];
const unchangedMaintenanceResult = { changed: false, bytesFreed: 0, rewrittenEntries: 0 } as const;

const sessionParams = {
  sessionIdUsed: "session-1",
  sessionId: "session-1",
  sessionKey: "agent:main",
  sessionFile: "sessions/main.jsonl",
};

describe("harness context engine lifecycle", () => {
  it("keeps hidden runtime-context custom messages out of assemble hooks", async () => {
    const visibleUser = textMessage("user", "visible ask", 1);
    const hiddenRuntimeContext = runtimeContextMessage("hidden runtime context", 2);
    const visibleAssistant = textMessage("assistant", "visible answer", 3);
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));

    await assembleHarnessContextEngine({
      contextEngine: createContextEngine({ assemble }),
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      messages: [visibleUser, hiddenRuntimeContext, visibleAssistant],
      modelId: "gpt-test",
    });

    const assembleParams = assemble.mock.calls.at(0)?.[0];
    expect(assembleParams?.messages).toEqual([visibleUser, visibleAssistant]);
  });

  it("keeps hidden runtime-context custom messages out of afterTurn hooks", async () => {
    const beforePromptUser = textMessage("user", "old ask", 1);
    const beforePromptRuntimeContext = runtimeContextMessage("old hidden context", 2);
    const beforePromptAssistant = textMessage("assistant", "old answer", 3);
    const turnUser = textMessage("user", "new ask", 4);
    const turnRuntimeContext = runtimeContextMessage("new hidden context", 5);
    const turnAssistant = textMessage("assistant", "new answer", 6);
    const afterTurn = vi.fn(async () => {});

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine({ afterTurn }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: sessionParams.sessionKey,
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [
        beforePromptUser,
        beforePromptRuntimeContext,
        beforePromptAssistant,
        turnUser,
        turnRuntimeContext,
        turnAssistant,
      ],
      prePromptMessageCount: 3,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: async () => undefined,
      warn: () => {},
    });

    const afterTurnCalls = (afterTurn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const afterTurnParams = afterTurnCalls[0]?.[0] as
      | { messages?: AgentMessage[]; prePromptMessageCount?: number }
      | undefined;
    expect(afterTurnParams?.messages).toEqual([
      beforePromptUser,
      beforePromptAssistant,
      turnUser,
      turnAssistant,
    ]);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
  });

  it("keeps hidden runtime-context custom messages out of ingestBatch fallbacks", async () => {
    const beforePromptUser = textMessage("user", "old ask", 1);
    const beforePromptRuntimeContext = runtimeContextMessage("old hidden context", 2);
    const beforePromptAssistant = textMessage("assistant", "old answer", 3);
    const turnUser = textMessage("user", "new ask", 4);
    const turnRuntimeContext = runtimeContextMessage("new hidden context", 5);
    const turnAssistant = textMessage("assistant", "new answer", 6);
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 2 }));

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine({ ingestBatch }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: sessionParams.sessionKey,
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [
        beforePromptUser,
        beforePromptRuntimeContext,
        beforePromptAssistant,
        turnUser,
        turnRuntimeContext,
        turnAssistant,
      ],
      prePromptMessageCount: 3,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: async () => undefined,
      warn: () => {},
    });

    const ingestBatchCalls = (ingestBatch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const ingestBatchParams = ingestBatchCalls[0]?.[0] as { messages?: AgentMessage[] } | undefined;
    expect(ingestBatchParams?.messages).toEqual([turnUser, turnAssistant]);
  });

  it("threads legacy session agent id into bootstrap maintenance", async () => {
    const runMaintenance = vi.fn(async (_params: HarnessMaintenanceParams) => undefined);

    await bootstrapHarnessContextEngine({
      hadSessionFile: true,
      contextEngine: createContextEngine({
        maintain: vi.fn(async () => unchangedMaintenanceResult),
      }),
      sessionId: sessionParams.sessionId,
      sessionKey: "legacy-session-key",
      sessionFile: sessionParams.sessionFile,
      runMaintenance,
      agentId: "legacy-owner",
      warn: () => {},
    });

    expect(runMaintenance).toHaveBeenCalledOnce();
    expect(runMaintenance.mock.calls[0]?.[0]).toMatchObject({
      reason: "bootstrap",
      sessionKey: "legacy-session-key",
      agentId: "legacy-owner",
    });
  });

  it("threads legacy session agent id into turn maintenance", async () => {
    const runMaintenance = vi.fn(async (_params: HarnessMaintenanceParams) => undefined);

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine(),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: "legacy-session-key",
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [textMessage("user", "ask", 1), textMessage("assistant", "answer", 2)],
      prePromptMessageCount: 1,
      runMaintenance,
      agentId: "legacy-owner",
      warn: () => {},
    });

    expect(runMaintenance).toHaveBeenCalledOnce();
    expect(runMaintenance.mock.calls[0]?.[0]).toMatchObject({
      reason: "turn",
      sessionKey: "legacy-session-key",
      agentId: "legacy-owner",
    });
  });

  it("passes harness context-engine maintenance agent id through to capability binding", async () => {
    const contextEngine = createContextEngine({
      maintain: vi.fn(async () => unchangedMaintenanceResult),
    });
    const mockedMaintenance = vi.mocked(runContextEngineMaintenance);
    mockedMaintenance.mockClear();

    await runHarnessContextEngineMaintenance({
      contextEngine,
      sessionId: sessionParams.sessionId,
      sessionKey: "legacy-session-key",
      sessionFile: sessionParams.sessionFile,
      reason: "compaction",
      agentId: "legacy-owner",
    });

    expect(mockedMaintenance).toHaveBeenCalledOnce();
    expect(mockedMaintenance.mock.calls[0]?.[0]).toMatchObject({
      reason: "compaction",
      sessionKey: "legacy-session-key",
      agentId: "legacy-owner",
    });
  });
});
