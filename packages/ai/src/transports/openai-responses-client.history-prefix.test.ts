import assert from "node:assert/strict";
import type { Context } from "@openclaw/llm-core";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { sanitizeTranscriptMessage } from "../../../../src/agents/transcript-sanitize.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { createModel, outputMessage } from "./openai-responses-prompt-observer.test-support.js";
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

it("preserves terminal reasoning bytes from warm continuation through cold transcript replay", async () => {
  const sessionId = "reasoning-container-prefix";
  const context: Context = {
    systemPrompt: "Stable instructions.",
    messages: [userMessage("Synthetic runtime context.", 0)],
    tools: [
      { name: "cache_probe", description: "Synthetic probe", parameters: { type: "object" } },
    ],
  };
  const host = getAiTransportHost();
  const requests: Record<string, unknown>[] = [];
  const prefixes: ReturnType<typeof snapshotProviderPrefix>[] = [];
  const history = new Map<string, unknown[]>();
  configureAiTransportHost({
    ...host,
    buildModelFetch: () => async (input, init) => {
      const payload: unknown = await new Request(input, init).json();
      assert(isRecord(payload) && Array.isArray(payload.input));
      const inherited =
        typeof payload.previous_response_id === "string"
          ? history.get(payload.previous_response_id)
          : [];
      assert(inherited);
      const effectiveInput = [...inherited, ...payload.input];
      requests.push(payload);
      // Match the release gate: ignore provider message/call envelopes, not reasoning fields.
      const comparable = effectiveInput.map((item) => {
        if (
          !isRecord(item) ||
          (item.type !== "function_call" && !(item.type === "message" && item.role === "assistant"))
        ) {
          return item;
        }
        const { id: _id, status: _status, ...rest } = item;
        return rest;
      });
      prefixes.push(
        snapshotProviderPrefix(
          "openai-responses",
          JSON.parse(stableStringify({ ...payload, input: comparable })),
        ),
      );
      const id = `response_${requests.length}`;
      const output = [
        reasoningItem(`rs_${id}`, `encrypted_${id}`),
        requests.length % 3 !== 0
          ? wireCall(id, "cache_probe")
          : outputMessage("Synthetic answer.", `msg_${id}`),
      ];
      history.set(id, [...effectiveInput, ...output]);
      const events = [
        ...output.flatMap((item, output_index) => [
          outputItem("added", item, output_index),
          outputItem(
            "done",
            item.type === "reasoning" ? { ...item, encrypted_content: `streamed_${id}_` } : item,
            output_index,
          ),
        ]),
        completedResponse(id, output, {
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        }),
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const stream = createOpenAIResponsesTransportStreamFn();
    for (let turn = 1; turn <= 4; turn++) {
      if (turn === 3) {
        context.messages.push(userMessage("Updated instructions.", 3));
      }
      if (turn === 4) {
        cleanupSessionResources(sessionId);
        const persistedTranscript = JSON.stringify(
          context.messages.map((message) => sanitizeTranscriptMessage(message)),
        );
        context.messages = JSON.parse(persistedTranscript);
      }
      context.messages.push(userMessage(`Before hook.\nVisible turn ${turn}.\nAfter hook.`, turn));
      for (let step = 0; step < 3; step++) {
        const response = await stream(model, context, {
          apiKey: "synthetic-prefix-key",
          sessionId,
          transport: "sse",
        });
        const assistant = await response.result();
        expect(assistant.errorMessage).toBeUndefined();
        context.messages.push(assistant);
        const call = assistant.content.find((block) => block.type === "toolCall");
        expect(assistant.stopReason).toBe(step < 2 ? "toolUse" : "stop");
        if (call) {
          context.messages.push(
            makeTextToolResult(call.id, call.name, "Synthetic record.", false, turn),
          );
        }
      }
    }
    expect(requests).toHaveLength(12);
    expect(requests[8]?.previous_response_id).toBe("response_8");
    expect(requests[9]?.previous_response_id).toBeUndefined();
    for (let index = 1; index < prefixes.length; index++) {
      const previous = prefixes[index - 1];
      const next = prefixes[index];
      assert(previous && next);
      assertStableProviderPrefix(previous, next, {
        label: `request ${index + 1}`,
      });
    }
    const reopenedReasoning = prefixes[9]?.history[2];
    assert(reopenedReasoning);
    expect(JSON.parse(reopenedReasoning)).toEqual(
      reasoningItem("rs_response_1", "encrypted_response_1"),
    );
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
              toolCall: structuredClone(event.toolCall),
              transcript,
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
        toolCall: {
          type: "toolCall",
          id: `call_${id}|fc_${id}`,
          name: "cache_probe",
          arguments: completed ? {} : { index: Number(id) },
          async: true,
        },
        transcript: expect.objectContaining({
          content: [
            thinking(reasoningId, completed ? encryptedContent : ciphertext),
            ...ids.map((callId) => expect.objectContaining({ id: `call_${callId}|fc_${callId}` })),
          ],
        }),
      })),
    );
  },
);
