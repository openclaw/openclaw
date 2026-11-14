import type { StreamFn } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { createCompactionModel } from "./compaction.test-support.js";
import { assistant, responseStream, user } from "./shard-fixtures.test-support.js";
import {
  runSummarizationCompletion,
  type SummarizationConversationSource,
} from "./summarization-completion.js";
import {
  createConversationSerializationIndex,
  prepareConversationMessage,
  serializeConversationSourceWithinBudget,
  type BoundedConversation,
} from "./utils.js";

describe("worker-owned summary input", () => {
  it("resamples the source after overflow and preserves the latest fact", async () => {
    const messages = {
      length: 200,
      get: (index: number) => user(`FACT-${index} ${"context ".repeat(1_000)}`),
    };
    const index = createConversationSerializationIndex(messages);
    for (let position = 0; position < messages.length; position++) {
      index.appendPrepared(position, prepareConversationMessage(messages.get(position)));
    }
    const budgets: number[] = [];
    const source: SummarizationConversationSource = {
      length: 200,
      async serialize(budget) {
        budgets.push(budget);
        return serializeConversationSourceWithinBudget(index.source, budget);
      },
    };
    const prompts: string[] = [];
    const streamFn: StreamFn = (model, context) => {
      const content = context.messages[0]?.content;
      const prompt = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
      prompts.push(prompt);
      const overflow = prompt.length > 60_000;
      return responseStream(
        assistant(overflow ? [] : "summary", {
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: overflow ? "error" : "stop",
          ...(overflow ? { errorMessage: "prompt is too long: 40000 tokens > 32768 maximum" } : {}),
        }),
      );
    };

    const result = await runSummarizationCompletion({
      messages: source,
      prompt: "Summarize the decisions.",
      model: createCompactionModel({ contextWindow: 200_000, maxTokens: 64_000 }),
      maxTokens: 16_384,
      apiKey: undefined,
      streamFn,
      errorLabel: "Summarization",
    });

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(prompts.length).toBeGreaterThan(1);
    const firstBudget = budgets[0];
    if (firstBudget === undefined) {
      throw new Error("Expected a summary request budget");
    }
    expect(budgets.at(-1)).toBeLessThan(firstBudget);
    expect(prompts.at(-1)?.length).toBeLessThanOrEqual(60_000);
    expect(prompts.at(-1)).toContain("FACT-199");
    expect(prompts.at(-1)).toContain("entries omitted ...]");
  });

  it("applies omission limits independently when prepared facts feed different ranges", () => {
    const message = user([{ type: "image", data: "synthetic", mimeType: "image/png" }]);
    const fact = prepareConversationMessage(message);
    const messages = { length: 9, get: () => message };
    const history = createConversationSerializationIndex(messages);
    const prefix = createConversationSerializationIndex(messages);
    for (let index = 0; index < messages.length; index++) {
      history.appendPrepared(index, fact);
    }
    prefix.appendPrepared(8, fact);

    expect(serializeConversationSourceWithinBudget(history.source, 10_000).text).toContain(
      "[More image/non-text data omitted from summary input]",
    );
    expect(serializeConversationSourceWithinBudget(prefix.source, 10_000).text).toBe(
      "[User]: [image data omitted from summary input]",
    );
  });

  it("does not dispatch a provider request after cancellation during source serialization", async () => {
    const controller = new AbortController();
    let publish: ((value: BoundedConversation) => void) | undefined;
    const pending = new Promise<BoundedConversation>((resolve) => {
      publish = resolve;
    });
    let requests = 0;
    const result = runSummarizationCompletion({
      messages: { length: 1, serialize: () => pending },
      prompt: "Summarize the decisions.",
      model: createCompactionModel(),
      maxTokens: 1_000,
      apiKey: undefined,
      signal: controller.signal,
      streamFn: () => {
        requests++;
        return responseStream(assistant("summary"));
      },
      errorLabel: "Summarization",
    });
    controller.abort();
    if (!publish) {
      throw new Error("Expected pending summary serialization");
    }
    publish({ text: "[User]: Keep the queue.", omittedEntries: 0, trimmedEntries: 0 });

    expect(await result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(requests).toBe(0);
  });
});
