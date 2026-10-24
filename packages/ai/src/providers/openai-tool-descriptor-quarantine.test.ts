import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import type { Tool } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { applyCommonResponsesParams } from "./openai-responses-shared.js";
import { streamOpenAIResponses } from "./openai-responses.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { publishRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

it.each(["openai-completions", "openai-responses"] as const)(
  "isolates payload-hook schema edits from published compatibility schemas for %s",
  async (api) => {
    const source = publishRuntimeToolInputSchema({
      type: "object",
      properties: { action: { type: "string", description: null } },
    }).schema;
    const parameters = normalizeOpenAIStrictCompatSchema(source);
    const context = {
      messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
      tools: [{ name: "choose", description: "Choose", parameters }],
    };
    const options = {
      apiKey: "fixture",
      onPayload(payload: unknown) {
        assert(isRecord(payload) && Array.isArray(payload.tools));
        const tool = payload.tools[0];
        assert(isRecord(tool));
        const schema = isRecord(tool.function) ? tool.function.parameters : tool.parameters;
        assert(isRecord(schema) && isRecord(schema.properties));
        assert(isRecord(schema.properties.action));
        expect(schema.properties.action.type).toBe("string");
        schema.properties.action.type = "number";
        throw new Error("hook edited its detached schema");
      },
    };
    for (let request = 0; request < 2; request++) {
      const stream =
        api === "openai-completions"
          ? streamOpenAICompletions(makeOpenAIProviderModel(api), context, options)
          : streamOpenAIResponses(makeOpenAIProviderModel(api), context, options);
      expect((await stream.result()).errorMessage).toContain("hook edited its detached schema");
    }
    expect(parameters).toHaveProperty("properties.action.type", "string");
  },
);

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
