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
const lowHigh = { supportedReasoningEfforts: ["low", "high"] };
function supported(labels: string[], mapped?: string): Model["compat"] {
  return {
    supportedReasoningEfforts: labels,
    ...(mapped === undefined ? {} : { reasoningEffortMap: { xhigh: mapped } }),
  };
}
type ReasoningCase = [
  name: string,
  level: ModelThinkingLevel | "none",
  map: Model["thinkingLevelMap"],
  compat: Model["compat"],
  expected: string | undefined,
];

describe.each(["openai-completions", "openai-responses"] as const)(
  "%s compatibility at the request boundary",
  (api) => {
    it.each<ReasoningCase>([
      ["constrains model mapping", "xhigh", { xhigh: "max" }, lowHigh, "high"],
      [
        "constrains compat mapping",
        "xhigh",
        undefined,
        { ...lowHigh, reasoningEffortMap: { xhigh: "max" } },
        "high",
      ],
      ["retains native case", "xhigh", { xhigh: "HIGH" }, supported(["LOW", "HIGH"]), "HIGH"],
      [
        "falls back to native label",
        "xhigh",
        undefined,
        supported(["ProviderLow"], "ProviderHigh"),
        "ProviderLow",
      ],
      ["preserves xhigh opt-in", "xhigh", undefined, supported(["low", "high", "xhigh"]), "xhigh"],
      [
        "null overrides compat map",
        "xhigh",
        { xhigh: null },
        supported(["high", "xhigh"], "xhigh"),
        undefined,
      ],
      [
        "disabled capability overrides maps",
        "xhigh",
        { xhigh: "xhigh" },
        { supportsReasoningEffort: false, reasoningEffortMap: { xhigh: "xhigh" } },
        undefined,
      ],
      ["unsupported off stays disabled", "off", { off: "minimal" }, lowHigh, undefined],
      ["none ignores off map", "none", { off: "low" }, supported(["none", "low", "high"]), "none"],
      ["unknown contract keeps native map", "xhigh", { xhigh: "ProviderHigh" }, {}, "ProviderHigh"],
    ])("%s", (_name, level, map, compat, expected) => {
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
