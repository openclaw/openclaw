// Every physical event keeps the connection alive, while advancing output alone
// resets the independent model-progress deadline.
import { describe, expect, it, vi } from "vitest";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import type { AssistantMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const model = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  name: "GPT-5.6 Luna",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 200_000,
});

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

describe("processResponsesStream request activity", () => {
  it("distinguishes physical activity from output advancement and repeated snapshots", async () => {
    const abortController = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(abortController.signal, onActivity);
    try {
      const events: Record<string, unknown>[] = [
        { type: "response.created", response: { id: "resp_activity" } },
        // Ignored bookkeeping event: no consumer-visible event is pushed.
        { type: "response.in_progress", response: { id: "resp_activity" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "reasoning_activity", type: "reasoning", summary: [] },
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 0,
          delta: "Synthetic hidden progress",
        },
        { type: "response.reasoning_text.delta", output_index: 0, delta: "" },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "reasoning_activity",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Synthetic snapshot" }],
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "reasoning_activity",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Synthetic snapshot" }],
          },
        },
        // Hosted tools do not use the model-output tracker. Repeated lifecycle
        // echoes must not masquerade as fresh model output.
        ...[
          "response.output_item.added",
          "response.output_item.done",
          "response.output_item.done",
        ].map((type) => ({
          type,
          output_index: 1,
          item: { id: "hosted_activity", type: "web_search_call", status: "completed" },
        })),
        {
          type: "response.completed",
          response: { id: "resp_activity", status: "completed", output: [] },
        },
      ];
      await processResponsesStream(eventStream(events), createOutput(), { push: () => {} }, model, {
        signal: abortController.signal,
      });
      expect(onActivity.mock.calls).toEqual(
        [false, false, true, true, false, true, false, false, false, false, true].map(
          (progress) => [progress, 900_000],
        ),
      );
    } finally {
      unsubscribe();
    }
  });
});
