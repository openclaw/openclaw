import { describe, expect, it } from "vitest";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
  type OpenAICompletionsOptions,
} from "./openai-completions.js";

const context: Context = {
  messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
};

async function capturePayload(
  compat: Model<"openai-completions">["compat"],
  off: string | null | undefined,
  request: {
    transport?: "direct" | "managed";
    reasoning?: SimpleStreamOptions["reasoning"];
    reasoningEffort?: OpenAICompletionsOptions["reasoningEffort"];
  } = {},
) {
  let payload: unknown;
  const model = {
    id: "mapped-thinking-model",
    name: "Mapped thinking model",
    provider: "synthetic-provider",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 32_000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: off === undefined ? undefined : { off },
    compat,
  } satisfies Model<"openai-completions">;
  const options = {
    apiKey: "synthetic-unused-key",
    reasoningEffort: request.reasoningEffort,
    onPayload(value) {
      payload = value;
      throw new Error("captured before network");
    },
  } satisfies OpenAICompletionsOptions;
  const stream = await (request.transport === "managed"
    ? createOpenAICompletionsTransportStreamFn()(model, context, {
        ...options,
        reasoning: request.reasoning,
      })
    : request.reasoning !== undefined
      ? streamSimpleOpenAICompletions(model, context, { ...options, reasoning: request.reasoning })
      : streamOpenAICompletions(model, context, options));
  const result = await stream.result();
  expect(result.errorMessage).toBe("captured before network");
  return payload;
}

describe("mapped off effort in chat completions", () => {
  it.each(
    ["openai", "openrouter"].flatMap((format) =>
      [undefined, "off" as const].map((effort) => ({ format, effort })),
    ),
  )("distinguishes an omitted effort from $effort for $format", async ({ format, effort }) => {
    const payload = await capturePayload(
      {
        supportsReasoningEffort: true,
        thinkingFormat: format === "openrouter" ? "openrouter" : "openai",
        supportedReasoningEfforts: ["none", "low", "high"],
      },
      undefined,
      { reasoningEffort: effort },
    );
    const field = format === "openrouter" ? "reasoning" : "reasoning_effort";
    if (effort === undefined) {
      expect(payload).not.toHaveProperty(field);
    } else {
      expect(payload).toMatchObject({
        [field]: format === "openrouter" ? { effort: "none" } : "none",
      });
    }
  });

  it.each(
    ["off", "OFF"].flatMap((key) => [undefined, "off" as const].map((effort) => ({ key, effort }))),
  )("honors canonical binary map $key for requested $effort", async ({ key, effort }) => {
    expect(
      await capturePayload(
        {
          thinkingFormat: "together",
          supportsReasoningEffort: true,
          reasoningEffortMap: { [key]: "low" },
        },
        undefined,
        { reasoningEffort: effort },
      ),
    ).toMatchObject({ reasoning: { enabled: true }, reasoning_effort: "low" });
  });

  it.each([
    ["zai", { thinking: { type: "enabled", clear_thinking: false } }],
    ["qwen", { enable_thinking: true }],
    [
      "qwen-chat-template",
      { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
    ],
    ["deepseek", { thinking: { type: "enabled" }, reasoning_effort: "low" }],
    ["openrouter", { reasoning: { effort: "low" } }],
    ["together", { reasoning: { enabled: true }, reasoning_effort: "low" }],
    ["openai", { reasoning_effort: "low" }],
  ] as const)("honors the model's off mapping for %s", async (thinkingFormat, expected) => {
    expect(
      await capturePayload({ thinkingFormat, supportsReasoningEffort: true }, "low"),
    ).toMatchObject(expected);
  });

  it.each([undefined, null, "none"])(
    "keeps Z.AI disabled for an unmapped or disabled off level: %s",
    async (off) => {
      expect(await capturePayload({ thinkingFormat: "zai" }, off)).toMatchObject({
        thinking: { type: "disabled" },
      });
    },
  );

  it("preserves an explicit none effort over the mapped default", async () => {
    expect(
      await capturePayload({ thinkingFormat: "zai" }, "low", { reasoningEffort: "none" }),
    ).toMatchObject({ thinking: { type: "disabled" } });
  });

  describe.each(["direct", "managed"] as const)("%s binary request boundary", (transport) => {
    it.each([
      { name: "optional omission", off: undefined, request: {}, enabled: undefined },
      { name: "logical off", off: undefined, request: { reasoning: "off" }, enabled: false },
      { name: "logical low", off: undefined, request: { reasoning: "low" }, enabled: true },
      { name: "native none", off: undefined, request: { reasoningEffort: "none" }, enabled: false },
      {
        name: "capped raw off",
        off: null,
        request: { reasoningEffort: "off" },
        enabled: undefined,
      },
      { name: "mandatory omission", off: null, request: {}, enabled: undefined },
      { name: "mandatory logical off", off: null, request: { reasoning: "off" }, enabled: true },
    ] as const)(
      "preserves OpenRouter $name without an effort selector",
      async ({ off, request, enabled }) => {
        const payload = await capturePayload(
          { thinkingFormat: "openrouter", supportsReasoningEffort: false },
          off,
          { ...request, transport },
        );
        if (enabled === undefined) {
          expect(payload).not.toHaveProperty("reasoning");
        } else {
          expect(payload).toMatchObject({ reasoning: { enabled } });
        }
        expect(payload).not.toHaveProperty("reasoning_effort");
        expect(payload).not.toHaveProperty("reasoning.effort");
      },
    );

    it.each([
      { mapping: "model off", logicalOff: false, enabled: false },
      { mapping: "model off", logicalOff: true, enabled: true },
      { mapping: "compat off", logicalOff: false, enabled: false },
      { mapping: "compat off", logicalOff: true, enabled: true },
      { mapping: "compat none", logicalOff: false, enabled: true },
    ])("honors $mapping with logicalOff=$logicalOff", async ({ mapping, logicalOff, enabled }) => {
      const payload = await capturePayload(
        {
          thinkingFormat: "together",
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "high"],
          ...(mapping === "compat off" ? { reasoningEffortMap: { off: "low" } } : {}),
          ...(mapping === "compat none" ? { reasoningEffortMap: { none: "low" } } : {}),
        },
        mapping === "model off" ? "low" : undefined,
        {
          transport,
          ...(logicalOff ? { reasoning: "off" } : { reasoningEffort: "none" }),
        },
      );
      expect(payload).toMatchObject({ reasoning: { enabled } });
      if (enabled) {
        expect(payload).toMatchObject({ reasoning_effort: "low" });
      } else {
        expect(payload).not.toHaveProperty("reasoning_effort");
      }
    });
  });

  it("gives provider compatibility metadata precedence over the model map", async () => {
    expect(
      await capturePayload({ thinkingFormat: "zai", reasoningEffortMap: { off: "low" } }, "none"),
    ).toMatchObject({ thinking: { type: "enabled", clear_thinking: false } });
  });
});
