import type { Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { assembleHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  captureEmbeddedAttemptContinuation,
  readEmbeddedContinuationPrefix,
} from "./attempt-continuation.js";

registerAgentSessionLoopTestLifecycle();

it("revises from completed lookup evidence when a context engine replaces history and no recorder exists", async () => {
  const read = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "The server listens on port 443." }],
    details: {},
  }));
  const { session } = await createTestSession({
    customTools: [
      {
        name: "read_fixture",
        label: "Read fixture",
        description: "Read fixture",
        parameters: Type.Object({}),
        execute: read,
      },
    ],
  });
  const requests: Message[][] = [];
  session.agent.streamFn = (_model, context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      createAssistant(
        testModel,
        requests.length === 1
          ? [{ type: "toolCall", id: "lookup", name: "read_fixture", arguments: {} }]
          : [
              {
                type: "text",
                text:
                  requests.length === 2
                    ? "Use port 443 and disable certificate checks."
                    : "Use port 443.",
              },
            ],
        requests.length === 1 ? "toolUse" : "stop",
      ),
    );
  };
  const capture = captureEmbeddedAttemptContinuation(
    { captureContinuationMessages: true },
    session,
  );
  await session.prompt("Find the server port.");
  capture.close();
  const continuation = await readEmbeddedContinuationPrefix({
    continuationMessages: capture.read(),
  });
  const assembled = await assembleHarnessContextEngine({
    contextEngine: {
      info: { id: "summary-fixture", name: "Summary fixture" },
      ingest: async () => ({ ingested: true }),
      assemble: async () => ({ messages: [], estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
    },
    sessionId: session.sessionId,
    agentId: "main",
    modelId: testModel.id,
    messages: session.messages,
    currentTurnMessages: continuation?.currentTurnMessages,
    tokenBudget: testModel.contextWindow,
  });
  session.agent.state.messages = assembled!.messages;
  await session.prompt("Remove the unsupported certificate advice. Reuse the completed lookup.");
  expect(read).toHaveBeenCalledOnce();
  expect(requests[2]).toContainEqual(
    expect.objectContaining({
      role: "toolResult",
      toolCallId: "lookup",
      content: [{ type: "text", text: "The server listens on port 443." }],
    }),
  );
  expect(
    requests[2]?.filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("Find the server port."),
    ),
  ).toHaveLength(1);
  expect(session.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Use port 443." }],
  });
});
