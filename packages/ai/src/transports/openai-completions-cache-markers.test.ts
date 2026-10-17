import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { publishRuntimeToolInputSchema } from "../providers/tool-schema-json-projection.js";
import type { Context } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAICompletionsRequest,
} from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

const model = makeCompletionsModel({
  provider: "openrouter",
  id: "anthropic/claude-sonnet-4-6",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
});
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

function markers(payload: unknown) {
  return JSON.stringify(payload).match(/"cache_control":/g) ?? [];
}

describe("Completions cache markers", () => {
  it.each([
    ["managed", "google/gemini-3.7-flash"],
    ["direct", "google/gemini-3.7-flash"],
    ["managed", "~google/gemini-3.7-flash"],
    ["direct", "~google/gemini-3.7-flash"],
    ["managed", "google/gemini-3.7-flash:online"],
    ["direct", "google/gemini-3.7-flash:online"],
    ["managed", "openrouter/~google/gemini-3.7-flash:online"],
    ["direct", "openrouter/~google/gemini-3.7-flash:online"],
  ] as const)("marks only the stable system prefix for %s OpenRouter %s", (mode, id) => {
    const route = { ...model, id };
    for (const cacheRetention of [undefined, "short", "long", "none"] as const) {
      for (const suffix of ["Today: 2026-09-06", "Today: 2026-09-07"]) {
        const payload = buildOpenAICompletionsRequest(
          route,
          { ...context, systemPrompt: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}` },
          { cacheRetention },
          mode === "direct"
            ? {
                mode,
                compat: resolveOpenAICompletionsCompat(route),
                cacheRetention: cacheRetention ?? "short",
              }
            : { mode },
        );
        expect(JSON.stringify(payload.messages)).toBe(
          JSON.stringify([
            {
              role: "system",
              content:
                cacheRetention === "none"
                  ? `STABLE\n${suffix}`
                  : [...marked("STABLE"), { type: "text", text: suffix }],
            },
            { role: "user", content: "Question" },
          ]),
        );
        expect(markers(payload)).toHaveLength(cacheRetention === "none" ? 0 : 1);
        expect(JSON.stringify(payload)).not.toContain('"ttl"');
      }
    }
  });

  it.each([
    ["custom", "https://openrouter.ai/api/v1", "google/gemini-3.7-flash", 1],
    ["openrouter", "", "google/gemini-3.7-flash", 1],
    ["openrouter", "https://proxy.example/v1", "google/gemini-3.7-flash", 0],
    [
      "google",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "google/gemini-3.7-flash",
      0,
    ],
    ["deepinfra", "https://api.deepinfra.com/v1/openai", "google/gemini-3.7-flash", 0],
    ["openrouter", "https://openrouter.ai/api/v1", "google/gemma-3-27b-it", 0],
  ])("scopes Gemini markers to %s at %s (%s)", (provider, baseUrl, id, count) => {
    const payload = buildOpenAICompletionsParams(
      { ...model, provider, baseUrl, id },
      { ...context, systemPrompt: "STABLE" },
      undefined,
    );
    expect(markers(payload)).toHaveLength(count);
    if (count) {
      expect(payload.messages[0]).toEqual({ role: "system", content: marked("STABLE") });
    }
  });

  it("keeps cache markers request-local when tool descriptors are published", () => {
    const { schema } = publishRuntimeToolInputSchema({ type: "object", properties: {} });
    assert(isRecord(schema));
    const publishedContext = {
      ...context,
      tools: [{ name: "lookup", description: "Lookup", parameters: schema }],
    };
    const markedRequest = buildOpenAICompletionsParams(model, publishedContext, {
      cacheRetention: "short",
    });
    const unmarkedRequest = buildOpenAICompletionsParams(model, publishedContext, {
      cacheRetention: "none",
    });
    expect(markedRequest.tools?.[0]).toHaveProperty("cache_control", marker);
    expect(unmarkedRequest.tools?.[0]).not.toHaveProperty("cache_control");
    expect(markedRequest.tools?.[0]?.function).toBe(unmarkedRequest.tools?.[0]?.function);
    expect(markedRequest.tools?.[0]).not.toBe(unmarkedRequest.tools?.[0]);
  });

  it("keeps every message as a string for string-only endpoints with caching enabled", () => {
    const payload = buildOpenAICompletionsParams(
      { ...model, compat: { requiresStringContent: true, cacheControlFormat: "anthropic" } },
      context,
      { cacheRetention: "short" },
    );
    expect(payload.messages).toEqual([
      { role: "system", content: "STABLE\nToday: 2026-09-06" },
      { role: "user", content: "Question" },
    ]);
    expect(payload.tools).toMatchObject([
      { function: { name: "alpha" } },
      { function: { name: "zeta" }, cache_control: marker },
    ]);
    expect(markers(payload)).toHaveLength(1);
  });

  it.each([undefined, false, true])(
    "honors explicit custom-endpoint long retention support: %s",
    (supportsLongCacheRetention) => {
      const payload = buildOpenAICompletionsParams(
        {
          ...model,
          provider: "custom",
          baseUrl: "https://proxy.example/v1",
          compat: { cacheControlFormat: "anthropic", supportsLongCacheRetention },
        },
        context,
        { cacheRetention: "long" },
      );
      expect(markers(payload)).toHaveLength(3);
      expect(JSON.stringify(payload).match(/"ttl":"1h"/g) ?? []).toHaveLength(
        supportsLongCacheRetention === true ? 3 : 0,
      );
    },
  );

  it("preserves the marked stable prefix across suffix changes and sorted tool permutations", () => {
    const first = buildOpenAICompletionsParams(model, context, undefined);
    const second = buildOpenAICompletionsParams(
      model,
      {
        ...context,
        systemPrompt: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: 2026-09-07`,
        tools: context.tools?.toReversed(),
      },
      undefined,
    );
    expect(first.messages).toEqual([
      {
        role: "system",
        content: [...marked("STABLE"), { type: "text", text: "Today: 2026-09-06" }],
      },
      { role: "user", content: marked("Question") },
    ]);
    expect(second.messages).toEqual([
      {
        role: "system",
        content: [...marked("STABLE"), { type: "text", text: "Today: 2026-09-07" }],
      },
      { role: "user", content: marked("Question") },
    ]);
    expect(first.tools).toEqual(second.tools);
    expect(first.tools).toMatchObject([
      { function: { name: "alpha" } },
      { function: { name: "zeta" }, cache_control: marker },
    ]);
    expect(markers(first)).toHaveLength(3);
  });

  it.each([true, false])(
    "skips runtime carriers after tool replay (supportsTools=%s)",
    (supportsTools) => {
      const route = { ...model, compat: { ...model.compat, supportsTools } };
      const toolLoop: Context["messages"] = [
        ...context.messages,
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "toolCall", id: "call_1", name: "alpha", arguments: {} }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "alpha",
          isError: false,
          content: [{ type: "text", text: "Result" }],
          timestamp: 3,
        },
      ];
      for (const [messages, anchor] of [
        [context.messages, "Question"],
        [toolLoop, supportsTools ? "Result" : "Question"],
        [[...toolLoop, { role: "user", content: "Next", timestamp: 4 }], "Next"],
      ] satisfies Array<[Context["messages"], string]>) {
        const payload = buildOpenAICompletionsParams(
          route,
          {
            ...context,
            messages: [
              ...messages,
              {
                role: "user",
                content: "OpenClaw runtime context:\nRuntime facts",
                timestamp: 5,
                runtimeContext: {},
              },
            ],
          },
          undefined,
        );
        const wire = JSON.stringify(payload.messages);
        expect(wire).toContain(JSON.stringify(marked(anchor)));
        expect(wire).toContain('"content":"OpenClaw runtime context:\\nRuntime facts"');
        expect(markers(payload)).toHaveLength(supportsTools ? 3 : 2);
      }
    },
  );

  it.each([
    ["openrouter", "", 3, true],
    ["custom", "https://openrouter.ai/api/v1", 3, true],
    ["deepinfra", "https://api.deepinfra.com/v1/openai", 3, false],
    ["dashscope", "", 2, false],
    ["custom", "https://dashscope.aliyuncs.com/compatible-mode/v1", 2, false],
    ["openrouter", "https://proxy.example/v1", 0, false],
    ["custom", "https://proxy.example/v1", 0, false],
  ])("honors retention and route contracts for %s at %s", (provider, baseUrl, count, longTtl) => {
    const route = { ...model, provider, baseUrl };
    for (const cacheRetention of [undefined, "short", "long", "none"] as const) {
      const payload = buildOpenAICompletionsParams(route, context, { cacheRetention });
      expect(markers(payload)).toHaveLength(cacheRetention === "none" ? 0 : count);
      expect(JSON.stringify(payload).includes('"ttl":"1h"')).toBe(
        longTtl && cacheRetention === "long",
      );
      expect(JSON.stringify(payload)).not.toContain(
        JSON.stringify(SYSTEM_PROMPT_CACHE_BOUNDARY).slice(1, -1),
      );
    }
  });
});
