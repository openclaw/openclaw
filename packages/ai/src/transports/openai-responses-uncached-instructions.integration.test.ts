import type { Context, Model } from "@openclaw/llm-core";
import { expect, it, onTestFinished } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { createResponsesLoopbackServer } from "./openai-responses-loopback.test-support.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
import {
  completedResponse,
  outputItem,
  userMessage,
  wireMessage,
} from "./openai-stream-cases.test-support.js";

// Native OpenAI route (the loopback rewrites only the destination of api.openai.com).
const uncachedModel = (compat?: Model["compat"]) =>
  createModel({ id: "gpt-6.2-astra", reasoning: true, ...(compat ? { compat } : {}) });

const compaction = { type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" };

async function runTurns(
  model: Model,
  prompts: Array<string | undefined>,
  compactAfterTurn?: number,
) {
  const server = await createResponsesLoopbackServer((turn) => {
    const message = wireMessage(`msg_${turn}`, `answer ${turn}`);
    const output = turn === compactAfterTurn ? [compaction, message] : [message];
    return [
      ...output.flatMap((item, index) => [
        outputItem("added", item, index),
        outputItem("done", item, index),
      ]),
      completedResponse(`resp_${turn}`, output, {
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }),
    ];
  });
  onTestFinished(() => server.close());
  const messages: Context["messages"] = [];
  for (const [index, systemPrompt] of prompts.entries()) {
    messages.push(userMessage(`question ${index + 1}`, index + 1));
    const stream = await createOpenAIResponsesTransportStreamFn()(
      model,
      { systemPrompt, messages: [...messages] },
      {
        apiKey: "synthetic-key",
        sessionId: "uncached-instructions",
        transport: "sse",
        onPayload: (payload: unknown) => ({ ...(payload as object), store: true }),
      } as never,
    );
    const assistant = await stream.result();
    expect(assistant.stopReason).toBe("stop");
    messages.push(assistant);
  }
  return server.requests;
}

type WireItem = { type?: string; role?: string; content?: Array<{ text?: string }> };
const systemTexts = (request: Record<string, unknown> | undefined) =>
  ((request?.input ?? []) as WireItem[])
    .filter((item) => item.role === "developer" || item.role === "system")
    .map((item) => item.content?.map((part) => part.text).join(""));

it("keeps the system prompt in instructions when the catalog does not mark it uncached", async () => {
  const [request] = await runTurns(uncachedModel(), ["Prompt A"]);
  expect(request?.instructions).toBe("Prompt A");
  expect(systemTexts(request)).toEqual([]);
});

it("sends an uncached-instructions prompt once as a developer item and replays when it changes", async () => {
  const requests = await runTurns(uncachedModel({ cachesInstructions: false }), [
    "Prompt A",
    "Prompt A",
    "Prompt B",
  ]);
  const [first, delta, changed] = requests;
  expect(first).not.toHaveProperty("instructions");
  expect((first?.input as WireItem[] | undefined)?.[0]).toMatchObject({
    type: "message",
    role: "developer",
  });
  expect(systemTexts(first)).toEqual(["Prompt A"]);
  // The stored response already carries the developer item; the delta must not repeat it.
  expect(delta?.previous_response_id).toBe("resp_1");
  expect(systemTexts(delta)).toEqual([]);
  // A changed prompt would conflict with the stored one, so the chain restarts.
  expect(changed).not.toHaveProperty("previous_response_id");
  expect(changed).not.toHaveProperty("instructions");
  expect(systemTexts(changed)).toEqual(["Prompt B"]);
  expect((changed?.input as WireItem[] | undefined)?.[0]).toMatchObject({ role: "developer" });
});

it("places the developer item right after the compaction item", async () => {
  const requests = await runTurns(
    uncachedModel({ cachesInstructions: false }),
    ["Prompt A", "Prompt B"],
    1,
  );
  const replay = requests[1];
  expect(replay).not.toHaveProperty("previous_response_id");
  const input = replay?.input as WireItem[];
  expect(input[0]).toMatchObject({ type: "compaction", id: "cmp_1" });
  expect(input[1]).toMatchObject({ type: "message", role: "developer" });
  expect(replay).not.toHaveProperty("instructions");
  expect(systemTexts(replay)).toEqual(["Prompt B"]);
});

it("restarts the stored chain when the prompt is removed or added", async () => {
  const [first, removed, added] = await runTurns(uncachedModel({ cachesInstructions: false }), [
    "Prompt A",
    undefined,
    "Prompt B",
  ]);
  expect(systemTexts(first)).toEqual(["Prompt A"]);
  expect(removed).not.toHaveProperty("previous_response_id");
  expect(systemTexts(removed)).toEqual([]);
  expect(added).not.toHaveProperty("previous_response_id");
  expect(systemTexts(added)).toEqual(["Prompt B"]);
});
