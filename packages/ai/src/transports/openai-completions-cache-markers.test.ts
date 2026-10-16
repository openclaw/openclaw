import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { publishRuntimeToolInputSchema } from "../providers/tool-schema-json-projection.js";
import type { Context } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import {
  createAssistantOutput,
  openRouterAnthropicModel,
} from "./openai-completions.test-support.js";

const model = { ...openRouterAnthropicModel, reasoning: false };
const context: Context = {
  systemPrompt: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: 2026-09-06`,
  tools: ["zeta", "alpha"].map((name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  })),
  messages: [{ role: "user", content: "Question", timestamp: 1 }],
};
const marker = { type: "ephemeral" };
const marked = (text: string) => [{ type: "text", text, cache_control: marker }];
const markedTools = [
  { function: { name: "alpha" } },
  { function: { name: "zeta" }, cache_control: marker },
];
const runtimeCarrier: Context["messages"][number] = {
  role: "user",
  content: "OpenClaw runtime context:\nRuntime facts",
  timestamp: 5,
  runtimeContext: {},
};
const wireMessages = (date: string) => [
  { role: "system", content: [...marked("STABLE"), { type: "text", text: `Today: ${date}` }] },
  { role: "user", content: marked("Question") },
];
function build(
  route: Partial<typeof model> = {},
  input: Partial<Context> = {},
  cacheRetention?: "short" | "long" | "none",
) {
  return buildOpenAICompletionsParams(
    { ...model, ...route },
    { ...context, ...input },
    { cacheRetention },
  );
}

const markers = (payload: unknown) => JSON.stringify(payload).match(/"cache_control":/g) ?? [];

it("keeps cache markers request-local when tool descriptors are published", () => {
  const { schema } = publishRuntimeToolInputSchema({ type: "object", properties: {} });
  assert(isRecord(schema));
  const tools = [{ name: "lookup", description: "Lookup", parameters: schema }];
  const markedRequest = build({}, { tools }, "short");
  const unmarkedRequest = build({}, { tools }, "none");
  expect(markedRequest.tools?.[0]).toHaveProperty("cache_control", marker);
  expect(unmarkedRequest.tools?.[0]).not.toHaveProperty("cache_control");
  expect(markedRequest.tools?.[0]?.function).toBe(unmarkedRequest.tools?.[0]?.function);
  expect(markedRequest.tools?.[0]).not.toBe(unmarkedRequest.tools?.[0]);
});

it("keeps every message as a string for string-only endpoints with caching enabled", () => {
  const payload = build(
    { compat: { requiresStringContent: true, cacheControlFormat: "anthropic" } },
    {},
    "short",
  );
  expect(payload.messages).toEqual([
    { role: "system", content: "STABLE\nToday: 2026-09-06" },
    { role: "user", content: "Question" },
  ]);
  expect(payload.tools).toMatchObject(markedTools);
  expect(markers(payload)).toHaveLength(1);
});

it("preserves the marked stable prefix across suffix changes and sorted tool permutations", () => {
  const first = build();
  const second = build(
    {},
    {
      systemPrompt: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: 2026-09-07`,
      tools: context.tools?.toReversed(),
    },
  );
  expect(first.messages).toEqual(wireMessages("2026-09-06"));
  expect(second.messages).toEqual(wireMessages("2026-09-07"));
  expect(first.tools).toEqual(second.tools);
  expect(first.tools).toMatchObject(markedTools);
  expect(markers(first)).toHaveLength(3);
});

it.each([true, false])(
  "skips runtime carriers after tool replay (supportsTools=%s)",
  (supportsTools) => {
    const route = { compat: { ...model.compat, supportsTools } };
    const toolLoop: Context["messages"] = [
      ...context.messages,
      {
        ...createAssistantOutput(model),
        content: [{ type: "toolCall", id: "call_1", name: "alpha", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 2,
      },
      makeTextToolResult("call_1", "alpha", "Result", false, 3),
    ];
    for (const [messages, anchor] of [
      [context.messages, "Question"],
      [toolLoop, supportsTools ? "Result" : "Question"],
      [[...toolLoop, { role: "user", content: "Next", timestamp: 4 }], "Next"],
    ] satisfies Array<[Context["messages"], string]>) {
      const payload = build(route, { messages: [...messages, runtimeCarrier] });
      const wire = JSON.stringify(payload.messages);
      expect(wire).toContain(JSON.stringify(marked(anchor)));
      expect(wire).toContain('"content":"OpenClaw runtime context:\\nRuntime facts"');
      expect(markers(payload)).toHaveLength(supportsTools ? 3 : 2);
    }
  },
);

it.each([
  ["openrouter", "", 3, true, undefined],
  ["custom", "https://openrouter.ai/api/v1", 3, true, undefined],
  ["deepinfra", "https://api.deepinfra.com/v1/openai", 3, false, undefined],
  ["dashscope", "", 2, false, undefined],
  ["custom", "https://dashscope.aliyuncs.com/compatible-mode/v1", 2, false, undefined],
  ["openrouter", "https://proxy.example/v1", 0, false, undefined],
  ["custom", "https://proxy.example/v1", 0, false, undefined],
  ["custom", "https://proxy.example/v1", 3, false, "unspecified"],
  ["custom", "https://proxy.example/v1", 3, false, false],
  ["custom", "https://proxy.example/v1", 3, true, true],
] as const)(
  "honors retention for %s at %s (%s markers, long TTL=%s, support=%j)",
  (provider, baseUrl, count, longTtl, support) => {
    const compat =
      support === undefined
        ? undefined
        : {
            cacheControlFormat: "anthropic" as const,
            supportsLongCacheRetention: support === "unspecified" ? undefined : support,
          };
    for (const cacheRetention of [undefined, "short", "long", "none"] as const) {
      const payload = build({ provider, baseUrl, compat }, {}, cacheRetention);
      expect(markers(payload)).toHaveLength(cacheRetention === "none" ? 0 : count);
      expect(JSON.stringify(payload).match(/"ttl":"1h"/g) ?? []).toHaveLength(
        longTtl && cacheRetention === "long" ? count : 0,
      );
    }
  },
);
