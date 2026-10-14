import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "../transports/openai-completions-params.js";
import type { Context, Model, ModelThinkingLevel } from "../types.js";
import { applyCommonResponsesParams } from "./openai-responses-shared.js";

const context: Context = {
  messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
};
const baseModel = {
  id: "compat-reasoning-model",
  name: "Compatibility reasoning model",
  provider: "custom-provider",
  baseUrl: "https://provider.example/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 32_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Omit<Model, "api">;

describe.each(["openai-completions", "openai-responses"] as const)(
  "%s compatibility at the request boundary",
  (api) => {
    it.each<{
      name: string;
      level: ModelThinkingLevel | "none";
      map?: Model["thinkingLevelMap"];
      compat: Model["compat"];
      expected: string | undefined;
    }>([
      {
        name: "model mapping constrained to accepted scalar labels",
        level: "xhigh",
        map: { xhigh: "max" },
        compat: { supportedReasoningEfforts: ["low", "high"] },
        expected: "high",
      },
      {
        name: "compat mapping constrained to accepted scalar labels",
        level: "xhigh",
        compat: {
          supportedReasoningEfforts: ["low", "high"],
          reasoningEffortMap: { xhigh: "max" },
        },
        expected: "high",
      },
      {
        name: "accepted native label retains exact case",
        level: "xhigh",
        map: { xhigh: "HIGH" },
        compat: { supportedReasoningEfforts: ["LOW", "HIGH"] },
        expected: "HIGH",
      },
      {
        name: "unsupported native label selects an accepted native value",
        level: "xhigh",
        compat: {
          supportedReasoningEfforts: ["ProviderLow"],
          reasoningEffortMap: { xhigh: "ProviderHigh" },
        },
        expected: "ProviderLow",
      },
      {
        name: "explicit xhigh opt-in is preserved",
        level: "xhigh",
        compat: { supportedReasoningEfforts: ["low", "high", "xhigh"] },
        expected: "xhigh",
      },
      {
        name: "hard null opt-out overrides a compat mapping",
        level: "xhigh",
        map: { xhigh: null },
        compat: {
          supportedReasoningEfforts: ["high", "xhigh"],
          reasoningEffortMap: { xhigh: "xhigh" },
        },
        expected: undefined,
      },
      {
        name: "disabled scalar capability overrides both mappings",
        level: "xhigh",
        map: { xhigh: "xhigh" },
        compat: { supportsReasoningEffort: false, reasoningEffortMap: { xhigh: "xhigh" } },
        expected: undefined,
      },
      {
        name: "unsupported off mapping cannot enable fallback thinking",
        level: "off",
        map: { off: "minimal" },
        compat: { supportedReasoningEfforts: ["low", "high"] },
        expected: undefined,
      },
      {
        name: "native none stays disabled without its own mapping",
        level: "none",
        map: { off: "low" },
        compat: { supportedReasoningEfforts: ["none", "low", "high"] },
        expected: "none",
      },
      {
        name: "an unknown contract preserves provider-native mappings",
        level: "xhigh",
        map: { xhigh: "ProviderHigh" },
        compat: {},
        expected: "ProviderHigh",
      },
    ])("$name", ({ level, map, compat, expected }) => {
      const model: Model = {
        ...baseModel,
        api,
        thinkingLevelMap: map,
        compat: { supportsReasoningEffort: true, ...compat },
      };
      if (api === "openai-completions") {
        const params = buildOpenAICompletionsParams(model, context, { reasoningEffort: level });
        expect(params.reasoning_effort).toBe(expected);
      } else {
        const params: ResponseCreateParamsStreaming = { model: model.id, input: [], stream: true };
        applyCommonResponsesParams(params, model, context, { reasoningEffort: level });
        expect(params.reasoning?.effort).toBe(expected);
      }
    });
  },
);
