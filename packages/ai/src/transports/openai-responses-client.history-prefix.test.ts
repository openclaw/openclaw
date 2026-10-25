import assert from "node:assert/strict";
import type { Context } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { sanitizeTranscriptMessage } from "../../../../src/agents/transcript-sanitize.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createModel,
  inputMessage,
  outputMessage,
  sseResponse,
} from "./openai-responses-prompt-observer.test-support.js";
import { createOpenAIResponsesAssistantOutput } from "./openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import {
  completedResponse,
  outputItem,
  userMessage,
  wireCall,
} from "./openai-stream-cases.test-support.js";

const model = createModel({
  compat: { supportsResponsesContinuation: true },
});

function reasoningItem(id: string, encrypted_content: string | null | undefined) {
  return { type: "reasoning", id, summary: [], content: [], encrypted_content };
}

function callItem(id: string, args = {}) {
  return { ...wireCall(id, "cache_probe", JSON.stringify(args)), async: true };
}

function thinking(id: string, encrypted_content: string | null | undefined) {
  const signature = { id, type: "reasoning", summary: [], content: [], encrypted_content };
  return { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(signature) };
}

it("replays terminal reasoning bytes after warm continuation and a persisted restart", async () => {
  const sessionId = "reasoning-container-prefix";
  const context: Context = { messages: [userMessage("First turn.", 1)] };
  const host = getAiTransportHost();
  const requests: Record<string, unknown>[] = [];
  configureAiTransportHost({
    ...host,
    buildModelFetch: () => async (input, init) => {
      requests.push(await new Request(input, init).json());
      const turn = requests.length;
      const reasoning = reasoningItem(`rs_${turn}`, `encrypted_${turn}`);
      return sseResponse([
        outputItem("done", { ...reasoning, encrypted_content: "partial-ciphertext" }),
        completedResponse(`response_${turn}`, [reasoning, outputMessage("Answer.", `msg_${turn}`)]),
      ]);
    },
  });
  try {
    const stream = createOpenAIResponsesTransportStreamFn();
    for (const turn of [1, 2, 3]) {
      if (turn === 3) {
        cleanupSessionResources(sessionId);
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON transcript replay.
        context.messages = JSON.parse(
          JSON.stringify(context.messages.map((message) => sanitizeTranscriptMessage(message))),
        );
      }
      if (turn > 1) {
        context.messages.push(userMessage(`Turn ${turn}.`, turn));
      }
      const pending = stream(model, context, {
        apiKey: "synthetic-prefix-key",
        sessionId,
        transport: "sse",
      });
      const result = await (await pending).result();
      expect(result.stopReason).toBe("stop");
      context.messages.push(result);
    }
    expect(requests[1]?.previous_response_id).toBe("response_1");
    expect(requests[1]?.input).toEqual([inputMessage("Turn 2.")]);
    expect(requests[2]?.previous_response_id).toBeUndefined();
    const coldInput = requests[2]?.input;
    assert(Array.isArray(coldInput));
    expect(coldInput.filter((item) => item.type === "reasoning")).toEqual([
      reasoningItem("rs_1", "encrypted_1"),
      reasoningItem("rs_2", "encrypted_2"),
    ]);
  } finally {
    configureAiTransportHost(host);
    cleanupSessionResources(sessionId);
  }
});

it.each<{ ending: string; encryptedContent?: string | null }>([
  { ending: "completed", encryptedContent: "terminal-ciphertext" },
  { ending: "completed", encryptedContent: undefined },
  { ending: "completed", encryptedContent: null },
  { ending: "stream error" },
  { ending: "error event" },
  { ending: "abort" },
  { ending: "missing terminal" },
])(
  "settles async transcript prefixes after $ending (ciphertext: $encryptedContent)",
  async ({ ending, encryptedContent }) => {
    const completed = ending === "completed";
    const controller = new AbortController();
    const reasoningId = completed ? "rs_async" : "rs_interrupted";
    const ciphertext = completed ? "streamed-ciphertext" : "item-done-ciphertext";
    const reasoning = reasoningItem(reasoningId, ciphertext);
    const ids = completed ? ["async"] : ["1", "2"];
    const calls = completed
      ? [callItem("async")]
      : [1, 2].map((index) =>
          Object.assign(callItem(String(index), { index }), { status: "completed" }),
        );
    let terminalSeen = false;
    const snapshots: unknown[] = [];
    const result = processResponsesStream(
      (async function* () {
        yield outputItem("done", reasoning);
        for (const [index, call] of calls.entries()) {
          yield outputItem("done", call, index + 1);
        }
        if (completed) {
          terminalSeen = true;
          yield completedResponse("resp_async", [
            { ...reasoning, encrypted_content: encryptedContent },
            ...calls,
          ]);
        }
        if (ending === "stream error") {
          throw new Error("Synthetic disconnect");
        }
        if (ending === "error event") {
          yield { type: "error", message: "Synthetic provider error" };
        }
        if (ending === "abort") {
          controller.abort();
        }
      })(),
      createOpenAIResponsesAssistantOutput(model),
      {
        push(event) {
          if (event.type === "toolcall_end") {
            const transcript = sanitizeTranscriptMessage(event.partial);
            assert(transcript.role === "assistant");
            snapshots.push({
              terminalSeen,
              id: event.toolCall.id,
              async: event.toolCall.async,
              content: transcript.content,
            });
          }
        },
      },
      model,
      { asyncToolExecution: true, signal: controller.signal },
    );
    if (completed) {
      await result;
    } else {
      await expect(result).rejects.toThrow(
        ending === "stream error"
          ? "Synthetic disconnect"
          : ending === "error event"
            ? "Synthetic provider error"
            : ending === "abort"
              ? /abort/i
              : "OpenAI Responses stream ended before a terminal response event",
      );
    }
    expect(snapshots).toEqual(
      ids.map((id) => ({
        terminalSeen: completed,
        id: `call_${id}|fc_${id}`,
        async: true,
        content: [
          thinking(reasoningId, completed ? encryptedContent : ciphertext),
          ...ids.map((callId) => expect.objectContaining({ id: `call_${callId}|fc_${callId}` })),
        ],
      })),
    );
  },
);
