import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model, ModelThinkingLevel } from "../types.js";
import { streamSimpleOpenAICompletions } from "./openai-completions.js";
import { streamSimpleOpenAIResponses } from "./openai-responses.js";

const context: Context = {
  messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }],
};

type ReasoningCase = {
  name: string;
  modelId?: string;
  requested: ModelThinkingLevel;
  compat?: Model["compat"];
  thinkingLevelMap?: Model["thinkingLevelMap"];
  expected: string | undefined;
  expectedResponses?: string;
};

const cases: ReasoningCase[] = [
  {
    name: "known model API max default",
    modelId: "gpt-5.6-sol",
    requested: "max",
    expected: "xhigh",
    expectedResponses: "max",
  },
  {
    name: "explicit compat max for a known model",
    modelId: "gpt-5.6-sol",
    requested: "max",
    compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    expected: "max",
  },
  {
    name: "declared native max",
    requested: "max",
    compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    thinkingLevelMap: { off: null, minimal: null },
    expected: "max",
  },
  {
    name: "declared xhigh",
    requested: "xhigh",
    compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    expected: "xhigh",
  },
  { name: "undeclared max", requested: "max", expected: "high" },
  { name: "plain minimal", requested: "minimal", expected: "minimal" },
  {
    name: "off map hole",
    requested: "off",
    thinkingLevelMap: { off: null },
    expected: "minimal",
  },
  {
    name: "explicit xhigh cap below max",
    requested: "xhigh",
    compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    thinkingLevelMap: { xhigh: null },
    expected: "high",
  },
  {
    name: "mapped max alias",
    requested: "max",
    thinkingLevelMap: { xhigh: "xhigh", max: "xhigh" },
    expected: "xhigh",
  },
  {
    name: "explicit reasoning serialization opt-out",
    requested: "high",
    compat: { supportsReasoningEffort: false },
    expected: undefined,
  },
];

describe.each(["openai-completions", "openai-responses"] as const)(
  "%s custom reasoning at the SDK request boundary",
  (api) => {
    afterEach(() => configureAiTransportHost({}));

    it.each(cases)("preserves $name", async (cell) => {
      const { requested, compat, thinkingLevelMap, expected } = cell;
      const modelId = cell.modelId ?? "custom-reasoner";
      const expectedResponses = cell.expectedResponses ?? expected;
      const model = {
        id: modelId,
        name: "Custom Reasoner",
        api,
        provider: "custom-provider",
        baseUrl: "https://reasoning.example/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat,
        thinkingLevelMap,
      } satisfies Model;
      const requests: {
        model: string;
        reasoning_effort?: string;
        reasoning?: { effort: string };
      }[] = [];
      configureAiTransportHost({
        buildModelFetch: () => async (input, init) => {
          const request = new Request(input, init);
          expect(request.method).toBe("POST");
          expect(new URL(request.url).pathname).toBe(
            api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses",
          );
          requests.push(await request.json());
          const event =
            api === "openai-completions"
              ? {
                  id: "reply",
                  choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
                }
              : {
                  type: "response.completed",
                  response: { id: "reply", status: "completed", output: [] },
                };
          return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });

      const options = { apiKey: "test-key", reasoning: requested };
      const result = await (
        api === "openai-completions"
          ? streamSimpleOpenAICompletions({ ...model, api }, context, options)
          : streamSimpleOpenAIResponses({ ...model, api }, context, options)
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe(modelId);
      expect(
        api === "openai-completions"
          ? requests[0]?.reasoning_effort
          : requests[0]?.reasoning?.effort,
      ).toBe(api === "openai-responses" ? expectedResponses : expected);
    });
  },
);
