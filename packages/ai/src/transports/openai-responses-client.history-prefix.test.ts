import assert from "node:assert/strict";
import type { Context, Model } from "@openclaw/llm-core";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { sanitizeTranscriptMessage } from "../../../../src/agents/transcript-sanitize.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { createOpenAIResponsesAssistantOutput } from "./openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.4",
  name: "Synthetic prefix replay",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  compat: { supportsResponsesContinuation: true },
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1024,
};

it("preserves terminal reasoning bytes from warm continuation through cold transcript replay", async () => {
  const sessionId = "reasoning-container-prefix";
  const context: Context = {
    systemPrompt: "Stable instructions.",
    messages: [{ role: "user", content: "Synthetic runtime context.", timestamp: 0 }],
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
        {
          type: "reasoning",
          id: `rs_${id}`,
          summary: [],
          content: [],
          encrypted_content: `encrypted_${id}`,
        },
        requests.length % 3 !== 0
          ? {
              type: "function_call",
              id: `fc_${id}`,
              call_id: `call_${id}`,
              name: "cache_probe",
              arguments: "{}",
            }
          : {
              type: "message",
              id: `msg_${id}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Synthetic answer.", annotations: [] }],
            },
      ];
      history.set(id, [...effectiveInput, ...output]);
      const events = [
        ...output.flatMap((item, output_index) => [
          { type: "response.output_item.added", output_index, item },
          {
            type: "response.output_item.done",
            output_index,
            item:
              item.type === "reasoning" ? { ...item, encrypted_content: `streamed_${id}_` } : item,
          },
        ]),
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output,
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        },
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
        context.messages.push({ role: "user", content: "Updated instructions.", timestamp: 3 });
      }
      if (turn === 4) {
        cleanupSessionResources(sessionId);
        const persistedTranscript = JSON.stringify(
          context.messages.map((message) => sanitizeTranscriptMessage(message)),
        );
        context.messages = JSON.parse(persistedTranscript);
      }
      context.messages.push({
        role: "user",
        content: `Before hook.\nVisible turn ${turn}.\nAfter hook.`,
        timestamp: turn,
      });
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
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "Synthetic record." }],
            isError: false,
            timestamp: turn,
          });
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
    expect(JSON.parse(reopenedReasoning)).toEqual({
      type: "reasoning",
      id: "rs_response_1",
      summary: [],
      content: [],
      encrypted_content: "encrypted_response_1",
    });
  } finally {
    configureAiTransportHost(host);
    cleanupSessionResources(sessionId);
  }
});

it.each(["terminal-ciphertext", undefined, null])(
  "settles async transcript prefixes with terminal ciphertext %s",
  async (encryptedContent) => {
    const output = createOpenAIResponsesAssistantOutput(model);
    const reasoning = {
      type: "reasoning",
      id: "rs_async",
      summary: [],
      content: [],
      encrypted_content: "streamed-ciphertext",
    };
    const call = {
      type: "function_call",
      id: "fc_async",
      call_id: "call_async",
      name: "cache_probe",
      arguments: "{}",
      async: true,
    };
    let terminalSeen = false;
    const snapshots: unknown[] = [];
    await processResponsesStream(
      (async function* () {
        yield { type: "response.output_item.done", output_index: 0, item: reasoning };
        yield { type: "response.output_item.done", output_index: 1, item: call };
        terminalSeen = true;
        yield {
          type: "response.completed",
          response: {
            id: "resp_async",
            status: "completed",
            output: [{ ...reasoning, encrypted_content: encryptedContent }, call],
          },
        };
      })(),
      output,
      {
        push(event) {
          if (event.type === "toolcall_end") {
            const snapshot = sanitizeTranscriptMessage(event.partial);
            assert(snapshot.role === "assistant");
            snapshots.push({ terminalSeen, reasoning: snapshot.content[0] });
          }
        },
      },
      model,
      { asyncToolExecution: true },
    );
    expect(snapshots).toEqual([
      {
        terminalSeen: true,
        reasoning: {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({
            id: "rs_async",
            type: "reasoning",
            summary: [],
            content: [],
            encrypted_content: encryptedContent,
          }),
        },
      },
    ]);
  },
);

it.each(["stream error", "error event", "abort", "missing terminal"])(
  "delivers completed async calls with item-done reasoning after %s",
  async (ending) => {
    const output = createOpenAIResponsesAssistantOutput(model);
    const controller = new AbortController();
    const reasoning = {
      type: "reasoning",
      id: "rs_interrupted",
      summary: [],
      content: [],
      encrypted_content: "item-done-ciphertext",
    };
    const snapshots: unknown[] = [];
    const result = processResponsesStream(
      (async function* () {
        yield { type: "response.output_item.done", output_index: 0, item: reasoning };
        for (let index = 1; index <= 2; index++) {
          yield {
            type: "response.output_item.done",
            output_index: index,
            item: {
              type: "function_call",
              id: `fc_${index}`,
              call_id: `call_${index}`,
              name: "cache_probe",
              arguments: JSON.stringify({ index }),
              status: "completed",
              async: true,
            },
          };
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
      output,
      {
        push(event) {
          if (event.type === "toolcall_end") {
            snapshots.push({
              toolCall: structuredClone(event.toolCall),
              transcript: sanitizeTranscriptMessage(event.partial),
            });
          }
        },
      },
      model,
      { asyncToolExecution: true, signal: controller.signal },
    );
    await expect(result).rejects.toThrow(
      ending === "stream error"
        ? "Synthetic disconnect"
        : ending === "error event"
          ? "Synthetic provider error"
          : ending === "abort"
            ? /abort/i
            : "OpenAI Responses stream ended before a terminal response event",
    );
    expect(snapshots).toEqual(
      [1, 2].map((index) => ({
        toolCall: {
          type: "toolCall",
          id: `call_${index}|fc_${index}`,
          name: "cache_probe",
          arguments: { index },
          async: true,
        },
        transcript: expect.objectContaining({
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify({
                id: "rs_interrupted",
                type: "reasoning",
                summary: [],
                content: [],
                encrypted_content: "item-done-ciphertext",
              }),
            },
            expect.objectContaining({ id: "call_1|fc_1" }),
            expect.objectContaining({ id: "call_2|fc_2" }),
          ],
        }),
      })),
    );
  },
);
