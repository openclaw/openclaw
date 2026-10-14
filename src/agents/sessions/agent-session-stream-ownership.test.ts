import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { runAgentLoop } from "../../../packages/agent-core/src/agent-loop.js";
import { processResponsesStream } from "../../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { persistAgentSessionMessage } from "./agent-session-transcript.js";
import { SessionManager } from "./session-manager.js";

it("finishes a Responses stream after persisting an async prefix without freezing its producer", async () => {
  const model: Model = {
    id: "test-model",
    name: "Test model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
  const replayMetadata = {
    v: 1 as const,
    source: "openai-responses" as const,
    provider: model.provider,
    api: model.api,
    model: model.id,
  };
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    summary: [{ type: "summary_text", text: "Synthetic reasoning" }],
    encrypted_content: "synthetic-ciphertext",
  };
  const call = {
    type: "function_call",
    id: "fc_test",
    call_id: "call_test",
    name: "lookup",
    arguments: "{}",
    status: "completed",
    async: true,
  };
  const answer = {
    type: "message",
    id: "msg_test",
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text: "Done.", annotations: [] }],
  };
  const prefixPersisted = createDeferred();
  const manager = SessionManager.inMemory();
  let prefixWasPersisted = false;
  const execute = vi.fn(async () => {
    expect(prefixWasPersisted).toBe(true);
    return { content: [{ type: "text" as const, text: "Found." }], details: {} };
  });
  async function* events() {
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_test", summary: [] },
    };
    yield { type: "response.output_item.done", output_index: 0, item: reasoning };
    yield {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...call, arguments: "", status: "in_progress" },
    };
    yield { type: "response.output_item.done", output_index: 1, item: call };
    // The real persistence boundary, not a timer, releases provider finalization.
    await prefixPersisted.promise;
    yield { type: "response.output_item.done", output_index: 2, item: answer };
    yield {
      type: "response.completed",
      response: {
        id: "resp_test",
        model: model.id,
        status: "completed",
        output: [reasoning, call, answer],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
  }
  const messages = await runAgentLoop(
    [{ role: "user", content: "Run lookup.", timestamp: 0 }],
    {
      systemPrompt: "Synthetic test",
      messages: [],
      tools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Lookup",
          parameters: Type.Object({}),
          execute,
        },
      ],
    },
    {
      model,
      convertToLlm: (history) => history as Context["messages"],
      shouldStopAfterTurn: () => true,
    },
    async (event) => {
      if (
        event.type !== "message_end" ||
        (event.message.role !== "user" &&
          event.message.role !== "assistant" &&
          event.message.role !== "toolResult")
      ) {
        return;
      }
      await persistAgentSessionMessage(manager, event.message, {
        invalidateSerializedPrefixCache: false,
      });
      if (
        event.message.role === "assistant" &&
        event.message.content.some((block) => block.type === "toolCall")
      ) {
        prefixWasPersisted = true;
        prefixPersisted.resolve();
      }
    },
    undefined,
    () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: output });
      void processResponsesStream(events(), output, stream, model, {
        asyncToolExecution: true,
        reasoningReplayMetadata: replayMetadata,
      }).then(
        () => {
          const reason = output.stopReason;
          if (reason === "error" || reason === "aborted") {
            stream.push({ type: "error", reason, error: output });
          } else {
            stream.push({ type: "done", reason, message: output });
          }
          stream.end();
        },
        (error: unknown) => {
          output.stopReason = "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
        },
      );
      return stream;
    },
  );

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
  expect(prefix?.role).toBe("assistant");
  if (prefix?.role !== "assistant") {
    throw new Error("Missing persisted async prefix");
  }
  const thinking = prefix.content[0];
  expect(thinking).toMatchObject({ type: "thinking", openclawReasoningReplay: replayMetadata });
  if (thinking?.type !== "thinking") {
    throw new Error("Missing persisted reasoning");
  }
  expect(JSON.parse(thinking.thinkingSignature ?? "null")).toMatchObject({
    id: "rs_test",
    encrypted_content: "synthetic-ciphertext",
  });
  expect(Object.isFrozen(thinking)).toBe(true);
  expect(persisted.findLast((message) => message.role === "assistant")).toMatchObject({
    content: [{ type: "text", text: "Done." }],
  });
});
