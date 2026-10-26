// Every physical event keeps the connection alive, while advancing output alone
// resets the independent model-progress deadline.
import { expect, it, vi } from "vitest";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { createAssistant } from "./openai-responses-prompt-observer.test-support.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";
import { outputItem, completedResponse } from "./openai-stream-cases.test-support.js";

const model = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  name: "GPT-5.6 Luna",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 200_000,
});

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

it("distinguishes physical activity from output advancement and repeated snapshots", async () => {
  const abortController = new AbortController();
  const onActivity = vi.fn();
  const unsubscribe = onLlmRequestActivity(abortController.signal, onActivity);
  try {
    const snapshot = outputItem("done", {
      id: "reasoning_activity",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Synthetic snapshot" }],
    });
    const events: Record<string, unknown>[] = [
      { type: "response.created", response: { id: "resp_activity" } },
      // Ignored bookkeeping event: no consumer-visible event is pushed.
      { type: "response.in_progress", response: { id: "resp_activity" } },
      outputItem("added", { id: "reasoning_activity", type: "reasoning", summary: [] }),
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        delta: "Synthetic hidden progress",
      },
      { type: "response.reasoning_text.delta", output_index: 0, delta: "" },
      structuredClone(snapshot),
      structuredClone(snapshot),
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
      completedResponse("resp_activity", []),
    ];
    await processResponsesStream(
      eventStream(events),
      createAssistant(model),
      { push: () => {} },
      model,
      {
        signal: abortController.signal,
      },
    );
    expect(onActivity.mock.calls).toEqual(
      [false, false, true, true, false, true, false, false, false, false, true].map((progress) => [
        progress,
        900_000,
      ]),
    );
  } finally {
    unsubscribe();
  }
});
