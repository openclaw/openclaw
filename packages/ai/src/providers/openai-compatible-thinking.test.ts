import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import { createOpenAIResponsesTransportStreamFn } from "../transports/openai-responses-transport.js";
import { completedResponse } from "../transports/openai-stream-cases.test-support.js";
import type { Context, Model, ModelThinkingLevel } from "../types.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai-responses.js";

const context: Context = { messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }] };

type ReasoningCase = {
  name: string;
  modelId?: string;
  provider?: string;
  compat?: Model["compat"];
  thinkingLevelMap?: Model["thinkingLevelMap"];
  toolRoute?: "native" | "proxy";
  expected: string | undefined;
  expectedResponses?: string;
} & (
  | { requested: ModelThinkingLevel; raw?: false }
  | { requested: ModelThinkingLevel | "none"; raw: true }
);

function mapped(
  name: string,
  requested: ModelThinkingLevel | "none",
  expected: string | undefined,
  overrides: Partial<Omit<ReasoningCase, "requested" | "raw">> = {},
): ReasoningCase {
  return requested === "none"
    ? { name, requested, raw: true, expected, ...overrides }
    : { name, requested, expected, ...overrides };
}

const nativeEfforts = ["low", "medium", "high", "xhigh", "max"];
const offEfforts = ["none", "low", "high"];
const providerEfforts = ["ProviderLow", "ProviderHigh"];
const codexMini = { modelId: "gpt-5.1-codex-mini", provider: "openai" };
const toolCall = {
  index: 0,
  id: "call_probe",
  type: "function",
  function: { name: "probe", arguments: "{}" },
};
const toolContext: Context = {
  ...context,
  tools: [
    {
      name: "probe",
      description: "Verify tool invocation.",
      parameters: Type.Object({}, { additionalProperties: false }),
    },
  ],
};

function efforts(supportedReasoningEfforts: string[], reasoningEffortMap?: Record<string, string>) {
  return { supportedReasoningEfforts, reasoningEffortMap };
}

const mappingCases: ReasoningCase[] = [
  mapped("codex-mini default", "low", "medium", codexMini),
  mapped("codex-mini declared capabilities", "low", "low", {
    ...codexMini,
    compat: efforts(["low", "high"]),
  }),
  mapped("codex-mini explicit user mapping", "low", "high", {
    ...codexMini,
    compat: efforts(["low", "high"], { LOW: "high" }),
  }),
  mapped("explicit compat max for a known model", "max", "max", {
    modelId: "gpt-5.6-sol",
    compat: efforts(nativeEfforts),
  }),
  mapped("declared native max", "max", "max", {
    compat: efforts(nativeEfforts),
    thinkingLevelMap: { off: null, minimal: null },
  }),
  mapped("declared xhigh", "xhigh", "xhigh", { compat: efforts(nativeEfforts.slice(0, -1)) }),
  mapped("undeclared max", "max", "high"),
  mapped("plain minimal", "minimal", "minimal"),
  ...[
    { name: "model off mapping", thinkingLevelMap: { off: "low" } },
    { name: "compat off mapping", reasoningEffortMap: { off: "low" } },
    { name: "null off cap", thinkingLevelMap: { off: null }, reasoningEffortMap: { off: "low" } },
  ].flatMap<ReasoningCase>(({ name, thinkingLevelMap, reasoningEffortMap }) => {
    const mapping = { thinkingLevelMap, compat: efforts(offEfforts, reasoningEffortMap) };
    return [
      mapped(`logical off follows ${name}`, "off", "low", mapping),
      mapped(`native none bypasses ${name}`, "none", "none", mapping),
    ];
  }),
  mapped("mapped max alias", "max", "xhigh", {
    thinkingLevelMap: { xhigh: "xhigh", max: "xhigh" },
  }),
  mapped("model-mapped low effort", "low", "medium", { thinkingLevelMap: { low: "medium" } }),
  mapped("provider-native mapping", "high", "ProviderHigh", {
    compat: efforts(providerEfforts, { high: "ProviderHigh" }),
  }),
  mapped("xhigh mapped below max", "xhigh", "high", {
    compat: efforts(["none", "high", "max"], { xhigh: "high" }),
  }),
  mapped("null xhigh cap overrides a max mapping", "xhigh", "high", {
    compat: efforts(["none", "high", "max"], { xhigh: "max" }),
    thinkingLevelMap: { xhigh: null },
  }),
  mapped("sparse max cap", "max", "high", { compat: efforts(["low", "high"]) }),
];

const adapterCases: ReasoningCase[] = [
  mapped("compat off mapping without an effort list", "off", "none", {
    compat: { reasoningEffortMap: { off: "none" } },
  }),
  mapped("model off mapping without an effort list", "off", "none", {
    thinkingLevelMap: { off: "none" },
  }),
  mapped("advertised ladder rejects a mapped disable", "off", undefined, {
    compat: efforts(["low", "high"], { off: "none" }),
  }),
  mapped("proxy model name cannot declare a disable control", "off", undefined, {
    modelId: "gpt-5.4",
  }),
  mapped("unknown off contract omits scalar effort", "off", undefined),
  mapped("unknown native none omits scalar effort", "none", undefined),
  mapped("off without disable support", "off", undefined, {
    compat: efforts(["low", "medium", "high"]),
  }),
  mapped("known model API max default", "max", "xhigh", {
    modelId: "gpt-5.6-sol",
    expectedResponses: "max",
  }),
  mapped("off map hole", "off", "minimal", { thinkingLevelMap: { off: null } }),
  mapped("advertised none default", "off", "none", { compat: efforts(offEfforts) }),
  mapped("native none keeps its explicit compat mapping", "none", "low", {
    compat: efforts(offEfforts, { none: "low", off: "high" }),
  }),
  ...[undefined, null].flatMap((cap) =>
    [false, true].map((raw): ReasoningCase => ({
      name: `${raw ? "raw" : "simple"} mapped native max with explicit cap ${cap}`,
      requested: "max",
      raw,
      compat: efforts(providerEfforts, { high: "ProviderLow", MAX: "ProviderHigh" }),
      thinkingLevelMap: cap === null ? { max: null } : undefined,
      expected: cap === null ? (raw ? undefined : "ProviderLow") : "ProviderHigh",
    })),
  ),
  mapped("serialization opt-out overrides a model mapping", "high", undefined, {
    compat: { supportsReasoningEffort: false },
    thinkingLevelMap: { high: "HIGH" },
  }),
  mapped("empty effort metadata overrides known model defaults", "max", undefined, {
    modelId: "gpt-5.6-sol",
    compat: efforts([]),
  }),
  ...[
    { modelId: "gpt-5.6-luna", expected: "none" },
    { modelId: "gpt-5.4-mini", expected: undefined },
    { modelId: "gpt-5.5", expected: undefined },
  ].map(({ modelId, expected }): ReasoningCase => ({
    name: `native ${modelId} tool reasoning contract`,
    modelId,
    toolRoute: "native",
    requested: "low",
    expected,
    expectedResponses: "low",
  })),
  mapped("proxy model retains its own tool reasoning contract", "low", "low", {
    modelId: "gpt-5.4-mini",
    toolRoute: "proxy",
    compat: { supportsReasoningEffort: true },
  }),
];

describe.each([
  "openai-completions",
  "openai-responses",
  "managed-completions",
  "managed-responses",
] as const)("%s custom reasoning at the SDK request boundary", (transport) => {
  const api =
    transport === "openai-completions" || transport === "managed-completions"
      ? "openai-completions"
      : "openai-responses";
  afterEach(() => configureAiTransportHost({}));

  // Shared mapping policy needs one wire boundary; adapters retain raw/simple and API-specific cases.
  const cases =
    transport === "managed-completions" ? [...mappingCases, ...adapterCases] : adapterCases;
  it.each(cases)("preserves $name", async (cell) => {
    const { requested, compat, thinkingLevelMap, expected } = cell;
    const modelId = cell.modelId ?? "custom-reasoner";
    // Managed Completions sends official OpenAI reasoning tool turns through Responses.
    const wireApi =
      transport === "managed-completions" && cell.toolRoute === "native" ? "openai-responses" : api;
    const model = makeOpenAIProviderModel(api, {
      id: modelId,
      name: "Custom Reasoner",
      provider: cell.provider ?? (cell.toolRoute === "native" ? "openai" : "custom-provider"),
      baseUrl:
        cell.toolRoute === "native" ? "https://api.openai.com/v1" : "https://reasoning.example/v1",
      contextWindow: 32_000,
      maxTokens: 1024,
      compat,
      thinkingLevelMap,
    });
    const requests: {
      model: string;
      reasoning_effort?: string;
      reasoning?: { effort: string };
      tools?: unknown[];
      tool_choice?: unknown;
    }[] = [];
    configureAiTransportHost({
      buildModelFetch: () => async (input, init) => {
        const request = new Request(input, init);
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe(
          wireApi === "openai-completions" ? "/v1/chat/completions" : "/v1/responses",
        );
        requests.push(await request.json());
        const event =
          wireApi === "openai-completions"
            ? {
                id: "reply",
                choices: [
                  {
                    index: 0,
                    delta: cell.toolRoute ? { tool_calls: [toolCall] } : { content: "OK" },
                    finish_reason: cell.toolRoute ? "tool_calls" : "stop",
                  },
                ],
              }
            : completedResponse("reply", []);
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const requestContext = cell.toolRoute ? toolContext : context;
    const commonOptions = {
      apiKey: "test-key",
      transport: "sse" as const,
      ...(cell.toolRoute ? { toolChoice: "required" as const } : {}),
    };
    const simpleOptions = { ...commonOptions, reasoning: cell.raw ? undefined : cell.requested };
    const rawOptions = { ...commonOptions, reasoningEffort: requested };
    const options = cell.raw ? rawOptions : simpleOptions;
    const stream = await (transport === "managed-responses"
      ? createOpenAIResponsesTransportStreamFn()(model, requestContext, options)
      : transport === "managed-completions"
        ? createOpenAICompletionsTransportStreamFn()(model, requestContext, options)
        : api === "openai-completions"
          ? cell.raw
            ? streamOpenAICompletions({ ...model, api }, requestContext, rawOptions)
            : streamSimpleOpenAICompletions({ ...model, api }, requestContext, simpleOptions)
          : cell.raw
            ? streamOpenAIResponses({ ...model, api }, requestContext, rawOptions)
            : streamSimpleOpenAIResponses({ ...model, api }, requestContext, simpleOptions));
    const result = await stream.result();
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe(
      cell.toolRoute && wireApi === "openai-completions" ? "toolUse" : "stop",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(modelId);
    if (cell.toolRoute) {
      expect(requests[0]?.tools).toHaveLength(1);
      if (wireApi === "openai-completions") {
        expect(requests[0]?.tool_choice).toBe("required");
      }
    }
    expect(
      wireApi === "openai-completions"
        ? requests[0]?.reasoning_effort
        : requests[0]?.reasoning?.effort,
    ).toBe(wireApi === "openai-responses" ? (cell.expectedResponses ?? expected) : expected);
  });
});
