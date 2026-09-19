// Context-engine loop-hook runtime-context threading, split from
// tool-result-context-guard.test.ts to respect its line-cap ratchet.

import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { installContextEngineLoopHook } from "./tool-result-context-guard.js";
import {
  makeGuardableAgent,
  makeToolResult,
  makeUser,
} from "./tool-result-context-guard.test-support.js";

type MockedEngine = ContextEngine & {
  assemble: ReturnType<typeof vi.fn<ContextEngine["assemble"]>>;
};

// Same default engine behavior as tool-result-context-guard.test.ts: echo
// assembled messages and own compaction without exercising a real engine.
function makeMockEngine(): MockedEngine {
  const assemble = vi.fn<ContextEngine["assemble"]>(
    async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }),
  );
  const engine = {
    info: {
      id: "test-engine",
      name: "Test Engine",
      version: "0.0.1",
      ownsCompaction: true,
    },
    ingest: vi.fn<ContextEngine["ingest"]>(async () => ({ ingested: true })),
    assemble,
    afterTurn: vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {}),
  } as unknown as MockedEngine;
  return engine;
}

function recordMockArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const arg = mock.mock.calls[callIndex]?.[argIndex];
  if (!arg || typeof arg !== "object") {
    throw new Error("expected mock argument record");
  }
  return arg as Record<string, unknown>;
}

async function callTransform(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  messages: AgentMessage[],
) {
  return await agent.transformContext?.(messages, new AbortController().signal);
}

describe("installContextEngineLoopHook runtime context", () => {
  it("threads the runtimeContext callback result into assemble, not just ingest", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const getRuntimeContext = vi.fn(() => ({ senderId: "user-42" }));
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId: "test-session-id",
      sessionKey: "agent:main:subagent:test",
      sessionFile: "/tmp/test-session.jsonl",
      tokenBudget: 4096,
      modelId: "test-model",
      getPrePromptMessageCount: () => 1,
      getRuntimeContext,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(recordMockArg(engine.assemble).runtimeContext).toEqual({ senderId: "user-42" });
  });
});
