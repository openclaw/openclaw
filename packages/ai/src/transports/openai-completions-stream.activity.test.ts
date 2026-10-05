// Content-free keepalive chunks must not re-arm the embedded-runner idle
// watchdog; only chunks carrying model progress count as request activity.
import { describe, expect, it, vi } from "vitest";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

async function countActivity(chunks: ReturnType<typeof makeCompletionsChunk>[]) {
  const model = makeCompletionsModel({ id: "test-model", name: "Test Model" });
  const output = createAssistantOutput(model);
  const abortController = new AbortController();
  const onActivity = vi.fn();
  const unsubscribe = onLlmRequestActivity(abortController.signal, onActivity);
  try {
    await processCompletionsStream(
      streamChunks(chunks),
      output,
      model,
      { push: () => {} },
      {
        signal: abortController.signal,
      },
    );
  } finally {
    unsubscribe();
  }
  return onActivity.mock.calls.length;
}

describe("openai completions stream request activity", () => {
  it("does not report activity for chunks with empty choices or empty deltas", async () => {
    const calls = await countActivity([
      makeCompletionsChunk({}, null, { choices: [] }),
      makeCompletionsChunk({}),
      makeCompletionsChunk({ role: "assistant" as const }),
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "Hi" }),
      makeCompletionsChunk({}, "stop" as const),
    ]);

    // Only the visible text chunk and the finish_reason chunk are progress.
    expect(calls).toBe(2);
  });

  it("reports activity for hidden reasoning, tool call, and usage chunks", async () => {
    const calls = await countActivity([
      makeCompletionsChunk({ reasoning_content: "thinking" }),
      makeCompletionsChunk({
        tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }],
      }),
      makeCompletionsChunk({}, "tool_calls" as const, {
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ]);

    expect(calls).toBe(3);
  });
});
