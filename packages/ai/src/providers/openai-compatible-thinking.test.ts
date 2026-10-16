import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import { createOpenAIResponsesTransportStreamFn } from "../transports/openai-responses-transport.js";
import type { Context, Model, ModelThinkingLevel } from "../types.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai-responses.js";

const context: Context = {
  messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }],
};

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
  requested: ModelThinkingLevel,
  expected: string | undefined,
  overrides: Partial<Omit<ReasoningCase, "requested" | "raw">> = {},
): ReasoningCase {
  return { name, requested, expected, ...overrides };
}

const nativeEfforts = ["low", "medium", "high", "xhigh", "max"];
const offEfforts = ["none", "low", "high"];
const providerEfforts = ["ProviderLow", "ProviderHigh"];

const mappingCases: ReasoningCase[] = [
  ...[
    { name: "default", compat: undefined, expected: "medium" },
    {
      name: "declared capabilities",
      compat: { supportedReasoningEfforts: ["low", "high"] },
      expected: "low",
    },
    {
      name: "explicit user mapping",
      compat: { supportedReasoningEfforts: ["low", "high"], reasoningEffortMap: { LOW: "high" } },
      expected: "high",
    },
  ].map(({ name, compat, expected }): ReasoningCase => ({
    name: `codex-mini ${name}`,
    modelId: "gpt-5.1-codex-mini",
    provider: "openai",
    requested: "low",
    compat,
    expected,
  })),
  mapped("explicit compat max for a known model", "max", "max", {
    modelId: "gpt-5.6-sol",
    compat: { supportedReasoningEfforts: nativeEfforts },
  }),
  mapped("declared native max", "max", "max", {
    compat: { supportedReasoningEfforts: nativeEfforts },
    thinkingLevelMap: { off: null, minimal: null },
  }),
  mapped("declared xhigh", "xhigh", "xhigh", {
    compat: { supportedReasoningEfforts: nativeEfforts.slice(0, -1) },
  }),
  mapped("undeclared max", "max", "high"),
  mapped("plain minimal", "minimal", "minimal"),
  ...[
    { name: "model off mapping", thinkingLevelMap: { off: "low" } },
    { name: "compat off mapping", reasoningEffortMap: { off: "low" } },
    {
      name: "null off cap",
      thinkingLevelMap: { off: null },
      reasoningEffortMap: { off: "low" },
    },
  ].flatMap<ReasoningCase>(({ name, thinkingLevelMap, reasoningEffortMap }) => {
    const mapping = {
      thinkingLevelMap,
      compat: { supportedReasoningEfforts: offEfforts, reasoningEffortMap },
    };
    return [
      mapped(`logical off follows ${name}`, "off", "low", mapping),
      {
        ...mapping,
        name: `native none bypasses ${name}`,
        requested: "none",
        raw: true,
        expected: "none",
      },
    ];
  }),
  mapped("mapped max alias", "max", "xhigh", {
    thinkingLevelMap: { xhigh: "xhigh", max: "xhigh" },
  }),
  mapped("model-mapped low effort", "low", "medium", {
    thinkingLevelMap: { low: "medium" },
  }),
  mapped("provider-native compatibility mapping", "high", "ProviderHigh", {
    compat: {
      supportedReasoningEfforts: providerEfforts,
      reasoningEffortMap: { high: "ProviderHigh" },
    },
  }),
  mapped("mapped xhigh below native max", "xhigh", "high", {
    compat: {
      supportedReasoningEfforts: ["none", "high", "max"],
      reasoningEffortMap: { xhigh: "high" },
    },
  }),
  mapped("null xhigh cap overrides a max mapping", "xhigh", "high", {
    compat: {
      supportedReasoningEfforts: ["none", "high", "max"],
      reasoningEffortMap: { xhigh: "max" },
    },
    thinkingLevelMap: { xhigh: null },
  }),
  mapped("sparse canonical efforts cap max at high", "max", "high", {
    compat: { supportedReasoningEfforts: ["low", "high"] },
  }),
];

const adapterCases: ReasoningCase[] = [
  mapped("known model API max default", "max", "xhigh", {
    modelId: "gpt-5.6-sol",
    expectedResponses: "max",
  }),
  mapped("off map hole", "off", "minimal", {
    thinkingLevelMap: { off: null },
  }),
  mapped("explicit off from advertised none without a map", "off", "none", {
    compat: { supportedReasoningEfforts: offEfforts },
  }),
  {
    name: "native none keeps its explicit compat mapping",
    requested: "none",
    raw: true,
    compat: {
      supportedReasoningEfforts: offEfforts,
      reasoningEffortMap: { none: "low", off: "high" },
    },
    expected: "low",
  },
  ...[undefined, null].flatMap((cap) =>
    [false, true].map((raw): ReasoningCase => ({
      name: `${raw ? "raw" : "simple"} mapped native max with explicit cap ${cap}`,
      requested: "max",
      raw,
      compat: {
        supportedReasoningEfforts: providerEfforts,
        reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
      },
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
    compat: { supportedReasoningEfforts: [] },
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
    const expectedResponses = cell.expectedResponses ?? expected;
    // Managed Completions sends official OpenAI reasoning tool turns through Responses.
    const wireApi =
      transport === "managed-completions" && cell.toolRoute === "native" ? "openai-responses" : api;
    const model = {
      id: modelId,
      name: "Custom Reasoner",
      api,
      provider: cell.provider ?? (cell.toolRoute === "native" ? "openai" : "custom-provider"),
      baseUrl:
        cell.toolRoute === "native" ? "https://api.openai.com/v1" : "https://reasoning.example/v1",
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
                  cell.toolRoute
                    ? {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call_probe",
                              type: "function",
                              function: { name: "probe", arguments: "{}" },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      }
                    : { index: 0, delta: { content: "OK" }, finish_reason: "stop" },
                ],
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

    const requestContext: Context = cell.toolRoute
      ? {
          ...context,
          tools: [
            {
              name: "probe",
              description: "Verify tool invocation.",
              parameters: Type.Object({}, { additionalProperties: false }),
            },
          ],
        }
      : context;
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
    ).toBe(wireApi === "openai-responses" ? expectedResponses : expected);
  });
});
