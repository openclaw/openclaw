import { expect, it, vi } from "vitest";
import type { Tool } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { applyCommonResponsesParams } from "./openai-responses-shared.js";

it("fails locally when a pinned official OpenAI tool is unreadable", async () => {
  const onPayload = vi.fn(() => {
    throw new Error("stop before network");
  });
  const stream = streamOpenAICompletions(
    makeOpenAIProviderModel("openai-completions"),
    {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: [
        {
          name: "broken",
          description: "Broken tool.",
          get parameters(): never {
            throw new Error("parameters exploded");
          },
        },
      ],
    },
    {
      apiKey: "fixture",
      toolChoice: { type: "function", function: { name: "broken" } },
      onPayload,
    },
  );

  const result = await stream.result();

  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain('requested unavailable tool "broken"');
  expect(onPayload).not.toHaveBeenCalled();
});

function unreadableInventory(): Tool[] {
  return new Proxy<Tool[]>([], {
    get(target, property, receiver) {
      if (property === "length") {
        throw new Error("length exploded");
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

it("does not reread an unreadable completions inventory length", async () => {
  let capturedPayload: unknown;
  const stream = streamOpenAICompletions(
    makeOpenAIProviderModel("openai-completions"),
    {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: unreadableInventory(),
    },
    {
      apiKey: "fixture",
      onPayload(payload) {
        capturedPayload = payload;
        throw new Error("stop before network");
      },
    },
  );

  expect((await stream.result()).stopReason).toBe("error");
  expect(capturedPayload).not.toHaveProperty("tools");
});

it("does not reread an unreadable Responses inventory length", () => {
  const params: Parameters<typeof applyCommonResponsesParams>[0] = {
    model: "gpt-5.5",
    input: [],
    stream: true,
  };
  applyCommonResponsesParams(params, makeOpenAIProviderModel("openai-responses"), {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: unreadableInventory(),
  });

  expect(params).not.toHaveProperty("tools");
});
