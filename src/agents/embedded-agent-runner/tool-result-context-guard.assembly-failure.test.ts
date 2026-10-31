import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { installContextEngineLoopHook } from "./tool-result-context-guard.js";
import {
  makeGuardableAgent,
  makeToolResult,
  makeUser,
} from "./tool-result-context-guard.test-support.js";

it("does not retry a failed context engine on every tool-loop iteration", async () => {
  const engine = {
    info: { id: "test-engine", name: "Test Engine", version: "0.0.1", ownsCompaction: true },
    afterTurn: vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {}),
    assemble: vi.fn<ContextEngine["assemble"]>(async () => {
      throw new Error("assembly failed");
    }),
    compact: vi.fn<ContextEngine["compact"]>(async () => {
      throw new Error("unexpected direct compaction");
    }),
    ingest: vi.fn<ContextEngine["ingest"]>(async () => ({ ingested: true })),
    ingestBatch: vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async ({ messages }) => ({
      ingestedCount: messages.length,
    })),
  } satisfies ContextEngine;
  const agent = makeGuardableAgent();
  const dispose = installContextEngineLoopHook({
    agent,
    contextEngine: engine,
    sessionId: "test-session",
    sessionKey: "agent:main:test",
    sessionFile: "/tmp/test-session.jsonl",
    tokenBudget: 4_096,
    modelId: "test-model",
    getPrePromptMessageCount: () => 1,
  });
  const run = (messages: ReturnType<typeof makeUser>[]) =>
    expectDefined(agent.transformContext, "installed hook")(
      messages,
      new AbortController().signal,
    );

  try {
    const firstTurn = [makeUser("first"), makeToolResult("one", "result")];
    await run(firstTurn);
    expect(engine.assemble).toHaveBeenCalledTimes(1);

    const nextToolIteration = [...firstTurn, makeToolResult("two", "result")];
    await run(nextToolIteration);
    expect(engine.assemble).toHaveBeenCalledTimes(1);

    const nextUserTurn = [
      ...nextToolIteration,
      makeUser("next turn"),
      makeToolResult("three", "result"),
    ];
    await run(nextUserTurn);
    expect(engine.assemble).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
  }
});
