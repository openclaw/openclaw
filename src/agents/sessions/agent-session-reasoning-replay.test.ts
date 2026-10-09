import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Context } from "../../llm/types.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

async function replayReasoning(signature: string) {
  const toolCall = {
    type: "toolCall" as const,
    id: "call_lookup",
    name: "lookup",
    arguments: { token: "synthetic-tool-input" },
  };
  const thinking = {
    type: "thinking" as const,
    thinking: "fresh summary",
    thinkingSignature: signature,
  };
  const fresh = createAssistant(
    testModel,
    [thinking, { type: "text", text: "Calling lookup" }, toolCall],
    "toolUse",
  );
  const approved = createAssistant(testModel, [
    { type: "thinking", thinking: "approved history", thinkingSignature: signature },
  ]);
  const approvedSnapshot = structuredClone(approved);
  const manager = guardSessionManager(SessionManager.inMemory(), { config: {} });
  const { session } = await createTestSession({
    sessionManager: manager,
    customTools: [
      {
        name: "lookup",
        label: "Lookup",
        description: "Return synthetic text.",
        parameters: Type.Object({ token: Type.String() }),
        execute: async (_id, args) => {
          expect(args).toEqual({ token: "synthetic-tool-input" });
          return { content: [{ type: "text", text: "found" }], details: {} };
        },
      },
    ],
  });
  session.agent.state.messages = [approved];
  const requests: Context["messages"][] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      requests.length === 1 ? fresh : createAssistant(model, [{ type: "text", text: "Done." }]),
    );
  });

  await session.prompt("Run lookup.");

  expect(requests).toHaveLength(2);
  const continuation = expectDefined(requests[1], "first tool continuation");
  const live = expectDefined(
    continuation
      .filter((message) => message.role === "assistant")
      .find((message) => message.content.some((block) => block.type === "toolCall")),
    "fresh assistant",
  );
  expect(live.content.slice(1)).toEqual([{ type: "text", text: "Calling lookup" }, toolCall]);
  expect(approved).toEqual(approvedSnapshot);
  expect(continuation[0]).toEqual(approvedSnapshot);
  const stored = manager
    .buildSessionContext()
    .messages.filter((message) => message.role === "assistant")
    .find((message) => message.content.some((block) => block.type === "toolCall"));
  expect(fresh.content[0]).toEqual({
    type: "thinking",
    thinking: "fresh summary",
    thinkingSignature: signature,
  });
  session.dispose();
  const { session: reopened } = await createTestSession({ sessionManager: manager });
  await reopened.prompt("Continue.");
  const restored = expectDefined(requests[2], "restored request")
    .filter((message) => message.role === "assistant")
    .find((message) => message.content.some((block) => block.type === "toolCall"));
  return { live: live.content[0], stored: stored?.content[0], restored: restored?.content[0] };
}

describe("local reasoning signature replay", () => {
  it("replays the stored encrypted signature on the first continuation and after reload", async () => {
    const replay = await replayReasoning(
      JSON.stringify({
        type: "reasoning",
        id: "rs_fresh",
        summary: [{ type: "summary_text", text: "fresh summary" }],
        content: [{ type: "reasoning_text", text: "fresh content" }],
        status: "completed",
        encrypted_content: "gAAAA-synthetic==",
      }),
    );
    const expected = {
      type: "thinking",
      thinking: "fresh summary",
      thinkingSignature: JSON.stringify({
        id: "rs_fresh",
        type: "reasoning",
        summary: [],
        status: "completed",
        encrypted_content: "gAAAA-synthetic==",
      }),
    };
    expect(replay.live).toEqual(expected);
    expect(replay.stored).toEqual(expected);
    expect(replay.restored).toEqual(expected);
  });

  it("keeps plaintext-only reasoning on the in-turn continuation", async () => {
    const signature = JSON.stringify({
      type: "reasoning",
      id: "rs_plain",
      summary: [],
      encrypted_content: null,
      content: [{ type: "reasoning_text", text: "fresh content" }],
    });
    const replay = await replayReasoning(signature);
    expect(replay.live).toEqual({
      type: "thinking",
      thinking: "fresh summary",
      thinkingSignature: signature,
    });
    const stored = {
      type: "thinking",
      thinking: "fresh summary",
      thinkingSignature: JSON.stringify({
        id: "rs_plain",
        type: "reasoning",
        summary: [],
        encrypted_content: null,
      }),
    };
    expect(replay.stored).toEqual(stored);
    expect(replay.restored).toEqual(stored);
  });
});
