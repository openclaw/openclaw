import * as crypto from "node:crypto";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { Message, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { assert, expect, it, vi } from "vitest";
import {
  captureToolLoop,
  finishMessageStream,
  makeTool,
  model as baseModel,
  reply,
} from "../../../packages/agent-core/src/agent-loop.test-support.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { createAssistantOutput } from "../../../packages/ai/src/transports/assistant-output.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "../../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { convertResponsesMessages } from "../../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "../../../packages/ai/src/transports/openai-responses-stream-internal.js";
import {
  completedResponse,
  outputItem,
  wireCall,
  wireMessage,
} from "../../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPromptCacheRequestObserver } from "../embedded-agent-runner/prompt-cache-request-observer.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { persistAgentSessionMessage } from "./agent-session-transcript.js";
import { SessionManager } from "./session-manager.js";

// mock-isolation: Keep native hashes while counting repeated history serialization.
vi.mock("node:crypto", { spy: true });

function isModelMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

it("does not rehash retained tool history after persistence projects reasoning metadata", async () => {
  const model: Model = { ...baseModel, api: "openai-responses", provider: "openai" };
  const manager = guardSessionManager(SessionManager.inMemory());
  const observer = createPromptCacheRequestObserver(
    { sessionId: "mutable-history-ownership", streamStrategy: "test" },
    () => {},
  );
  const wire = (messages: Message[]) =>
    JSON.stringify(convertResponsesMessages(model, { messages }, new Set(["openai"])));
  let turn = 0;
  try {
    const loop = captureToolLoop({
      config: { model },
      tools: [{ ...makeTool("lookup"), parameters: Type.Object({ nested: Type.Any() }) }],
      onMessage: async (message) => {
        if (isModelMessage(message)) {
          const before = wire([message]);
          await persistAgentSessionMessage(manager, message, {
            invalidateSerializedPrefixCache: false,
          });
          expect(wire([message])).toBe(before);
        }
      },
      streamFn: async (_, context) => {
        vi.mocked(crypto.hash).mockClear();
        await observer.onModelRequest(model, context);
        for (let previous = 1; previous < turn; previous++) {
          expect(
            vi
              .mocked(crypto.hash)
              .mock.calls.filter(
                ([, input]) =>
                  typeof input === "string" && input.includes(`retained-argument-${previous}`),
              ),
          ).toHaveLength(0);
        }
        turn++;
        return reply({
          ...createAssistantOutput(model),
          stopReason: turn < 4 ? "toolUse" : "stop",
          content:
            turn < 4
              ? [
                  {
                    type: "thinking",
                    thinking: "Inspect the fixture",
                    thinkingSignature: JSON.stringify({
                      type: "reasoning",
                      id: `rs_${turn}`,
                      summary: [{ type: "summary_text", text: "Inspect the fixture" }],
                      encrypted_content: "synthetic-ciphertext",
                    }),
                  },
                  {
                    type: "toolCall",
                    id: `call_${turn}`,
                    name: "lookup",
                    arguments: { nested: { marker: `retained-argument-${turn}` } },
                  },
                ]
              : [{ type: "text", text: "Done." }],
        });
      },
    });
    await loop.run;
    expect(turn).toBe(4);
  } finally {
    manager.clearTranscriptRunCallbacks?.();
  }
});

it.each([
  "item-done",
  "terminal-without-item-done",
  "terminal-without-item-done-absent-ciphertext",
] as const)(
  "persists replayable reasoning arriving at %s after an async prefix without freezing its producer",
  async (arrival) => {
    const hasItemDone = !arrival.startsWith("terminal-without-item-done");
    const model: Model = {
      ...baseModel,
      name: "Test model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const replayIdentity = { sessionId: "synthetic-session", authProfileId: "synthetic-profile" };
    const replayMetadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
    const output = createAssistantOutput(model);
    const reasoning = {
      type: "reasoning",
      id: "rs_test",
      summary: [{ type: "summary_text", text: "Synthetic reasoning" }],
      ...(arrival.endsWith("absent-ciphertext")
        ? {}
        : { encrypted_content: "synthetic-ciphertext" }),
    };
    const call = { ...wireCall("test", "lookup"), status: "completed", async: true };
    const answer = { ...wireMessage("msg_test", "Done."), phase: "final_answer" };
    const answerStreamed = createDeferred();
    const manager = SessionManager.inMemory();
    let prefixWasPersisted = false;
    let terminalSeen = false;
    const execute = vi.fn(async () => {
      expect(prefixWasPersisted).toBe(true);
      expect(terminalSeen).toBe(true);
      return { content: [{ type: "text" as const, text: "Found." }], details: {} };
    });
    async function* events() {
      yield outputItem("added", { type: "reasoning", id: "rs_test", summary: [] });
      if (hasItemDone) {
        yield outputItem("done", { ...reasoning, encrypted_content: "streamed-ciphertext" });
      }
      yield outputItem("added", { ...call, arguments: "", status: "in_progress" }, 1);
      yield outputItem("done", call, 1);
      yield outputItem("added", { ...answer, status: "in_progress", content: [] }, 2);
      yield {
        type: "response.content_part.added",
        output_index: 2,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      };
      yield { type: "response.output_text.delta", output_index: 2, delta: "Done." };
      // Let the consumer observe streaming progress before the terminal replay payload.
      await answerStreamed.promise;
      expect(prefixWasPersisted).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      yield outputItem("done", answer, 2);
      terminalSeen = true;
      yield completedResponse("resp_test", [reasoning, call, answer], {
        model: model.id,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      });
    }
    const loop = captureToolLoop({
      prompt: { role: "user", content: "Run lookup.", timestamp: 0 },
      tools: [{ ...makeTool("lookup"), execute }],
      config: { model, shouldStopAfterTurn: () => true },
      onEvent: (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          answerStreamed.resolve();
        }
      },
      onMessage: async (message) => {
        if (!isModelMessage(message)) {
          return;
        }
        await persistAgentSessionMessage(manager, message, {
          invalidateSerializedPrefixCache: false,
        });
        if (
          message.role === "assistant" &&
          message.content.some((block) => block.type === "toolCall")
        ) {
          prefixWasPersisted = true;
        }
      },
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: output });
        void processResponsesStream(events(), output, stream, model, {
          asyncToolExecution: true,
          reasoningReplayMetadata: replayMetadata,
        })
          .catch((error: unknown) => {
            output.stopReason = "error";
            output.errorMessage = error instanceof Error ? error.message : String(error);
          })
          .then(() => finishMessageStream(stream, output));
        return stream;
      },
    });
    const messages = await loop.run;

    const final = messages.findLast((message) => message.role === "assistant");
    expect(
      final?.role === "assistant" ? final.errorMessage : "Missing final assistant",
    ).toBeUndefined();
    expect(final).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Done." }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(messages.filter((message) => message.role === "toolResult")).toMatchObject([
      { isError: false, content: [{ type: "text", text: "Found." }] },
    ]);
    const persisted = manager.buildSessionContext().messages;
    const prefix = persisted.find(
      (message) =>
        message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
    );
    assert(prefix?.role === "assistant", "Missing persisted async prefix");
    const thinking = prefix.content[0];
    assert(thinking?.type === "thinking", "Missing persisted reasoning");
    if (hasItemDone) {
      const signature = JSON.parse(thinking.thinkingSignature ?? "null");
      expect(signature).toMatchObject({ id: "rs_test" });
      expect(thinking).toHaveProperty("openclawReasoningReplay", replayMetadata);
      expect(signature).toHaveProperty("encrypted_content", "synthetic-ciphertext");
    }
    expect(Object.isFrozen(thinking)).toBe(true);
    expect(persisted.findLast((message) => message.role === "assistant")).toMatchObject({
      content: [{ type: "text", text: "Done." }],
    });

    // Reconstruct a cold request from recorded history, without a cached response handle.
    const coldInput = convertResponsesMessages(
      model,
      {
        messages: [
          ...persisted.filter(isModelMessage),
          { role: "user", content: "Continue.", timestamp: 2 },
        ],
      },
      new Set(["openai"]),
      { includeSystemPrompt: false, ...replayIdentity },
    );
    expect(coldInput).toContainEqual(
      expect.objectContaining({ type: "reasoning", id: "rs_test", summary: [] }),
    );
    const serializedInput = JSON.stringify(coldInput);
    if (reasoning.encrypted_content) {
      expect(serializedInput).toContain('"encrypted_content":"synthetic-ciphertext"');
    } else {
      expect(thinking).not.toHaveProperty("openclawReasoningReplay");
      expect(serializedInput).not.toContain('"encrypted_content":"synthetic-ciphertext"');
    }
    expect(serializedInput).not.toContain("openclawReasoningReplay");
  },
);
