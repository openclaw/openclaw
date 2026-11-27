import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import type { Context, Tool } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { streamOpenAIResponses } from "./openai-responses.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { publishRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

const messages: Context["messages"] = [{ role: "user", content: "hello", timestamp: 0 }];
const apis = ["openai-completions", "openai-responses"] as const;
function start(api: (typeof apis)[number], tools: Tool[], onPayload: (payload: unknown) => void) {
  const context = { messages, tools };
  const options = { apiKey: "fixture", onPayload };
  return api === "openai-completions"
    ? streamOpenAICompletions(makeOpenAIProviderModel(api), context, options)
    : streamOpenAIResponses(makeOpenAIProviderModel(api), context, options);
}

it.each(apis)(
  "isolates payload-hook schema edits from published compatibility schemas for %s",
  async (api) => {
    const source = publishRuntimeToolInputSchema({
      type: "object",
      properties: { action: { type: "string", description: null } },
    }).schema;
    const parameters = normalizeOpenAIStrictCompatSchema(source);
    const onPayload = (payload: unknown) => {
      assert(isRecord(payload) && Array.isArray(payload.tools));
      const tool = payload.tools[0];
      assert(isRecord(tool));
      const schema = isRecord(tool.function) ? tool.function.parameters : tool.parameters;
      assert(isRecord(schema) && isRecord(schema.properties));
      assert(isRecord(schema.properties.action));
      expect(schema.properties.action.type).toBe("string");
      schema.properties.action.type = "number";
      throw new Error("hook edited its detached schema");
    };
    for (let request = 0; request < 2; request++) {
      const stream = start(api, [{ name: "choose", description: "Choose", parameters }], onPayload);
      expect((await stream.result()).errorMessage).toContain("hook edited its detached schema");
    }
    expect(parameters).toHaveProperty("properties.action.type", "string");
  },
);

it("fails locally when a pinned official OpenAI tool is unreadable", async () => {
  const onPayload = vi.fn(() => {
    throw new Error("stop before network");
  });
  const broken: Tool = {
    name: "broken",
    description: "Broken tool.",
    get parameters(): never {
      throw new Error("parameters exploded");
    },
  };
  const stream = streamOpenAICompletions(
    makeOpenAIProviderModel("openai-completions"),
    { messages, tools: [broken] },
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

it.each(apis)("does not reread an unreadable %s inventory length", async (api) => {
  let capturedPayload: unknown;
  const stream = start(api, unreadableInventory(), (payload) => {
    capturedPayload = payload;
    throw new Error("stop before network");
  });

  expect(await stream.result()).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("stop before network"),
  });
  expect(capturedPayload).not.toHaveProperty("tools");
});
