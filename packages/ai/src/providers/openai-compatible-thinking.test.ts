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

const cases: ReasoningCase[] = [
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
    name: "explicit off from advertised none without a map",
    requested: "off",
    compat: { supportedReasoningEfforts: ["none", "low", "high"] },
    expected: "none",
  },
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
      compat: { supportedReasoningEfforts: ["none", "low", "high"], reasoningEffortMap },
    };
    return [
      {
        ...mapping,
        name: `logical off follows ${name}`,
        requested: "off",
        expected: "low",
      },
      {
        ...mapping,
        name: `native none bypasses ${name}`,
        requested: "none",
        raw: true,
        expected: "none",
      },
    ];
  }),
  {
    name: "native none keeps its explicit compat mapping",
    requested: "none",
    raw: true,
    compat: {
      supportedReasoningEfforts: ["none", "low", "high"],
      reasoningEffortMap: { none: "low", off: "high" },
    },
    expected: "low",
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
    name: "model-mapped low effort",
    requested: "low",
    thinkingLevelMap: { low: "medium" },
    expected: "medium",
  },
  {
    name: "explicit reasoning serialization opt-out",
    requested: "high",
    compat: { supportsReasoningEffort: false },
    expected: undefined,
  },
  {
    name: "provider-native compatibility mapping",
    requested: "high",
    compat: {
      supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
      reasoningEffortMap: { high: "ProviderHigh" },
    },
    expected: "ProviderHigh",
  },
  ...[undefined, null].flatMap((cap) =>
    [false, true].map((raw): ReasoningCase => ({
      name: `${raw ? "raw" : "simple"} mapped native max with explicit cap ${cap}`,
      requested: "max",
      raw,
      compat: {
        supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
        reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
      },
      thinkingLevelMap: cap === null ? { max: null } : undefined,
      expected: cap === null ? (raw ? undefined : "ProviderLow") : "ProviderHigh",
    })),
  ),
  {
    name: "mapped xhigh below native max",
    requested: "xhigh",
    compat: {
      supportedReasoningEfforts: ["none", "high", "max"],
      reasoningEffortMap: { xhigh: "high" },
    },
    expected: "high",
  },
  {
    name: "null xhigh cap overrides a max mapping",
    requested: "xhigh",
    compat: {
      supportedReasoningEfforts: ["none", "high", "max"],
      reasoningEffortMap: { xhigh: "max" },
    },
    thinkingLevelMap: { xhigh: null },
    expected: "high",
  },
  {
    name: "serialization opt-out overrides a model mapping",
    requested: "high",
    compat: { supportsReasoningEffort: false },
    thinkingLevelMap: { high: "HIGH" },
    expected: undefined,
  },
  {
    name: "empty effort metadata overrides known model defaults",
    modelId: "gpt-5.6-sol",
    requested: "max",
    compat: { supportedReasoningEfforts: [] },
    expected: undefined,
  },
  {
    name: "sparse canonical efforts cap max at high",
    requested: "max",
    compat: { supportedReasoningEfforts: ["low", "high"] },
    expected: "high",
  },
  {
    name: "sparse canonical efforts cap high at medium",
    requested: "high",
    compat: { supportedReasoningEfforts: ["low", "medium"] },
    expected: "medium",
  },
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
  {
    name: "proxy model retains its own tool reasoning contract",
    modelId: "gpt-5.4-mini",
    toolRoute: "proxy",
    requested: "low",
    compat: { supportsReasoningEffort: true },
    expected: "low",
  },
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

  it.each(cases)("preserves $name", async (cell) => {
    const { requested, compat, thinkingLevelMap, expected } = cell;
    const modelId = cell.modelId ?? "custom-reasoner";
    const expectedResponses = cell.expectedResponses ?? expected;
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
          api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses",
        );
        requests.push(await request.json());
        const event =
          api === "openai-completions"
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
      cell.toolRoute && api === "openai-completions" ? "toolUse" : "stop",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(modelId);
    if (cell.toolRoute) {
      expect(requests[0]?.tools).toHaveLength(1);
      if (api === "openai-completions") {
        expect(requests[0]?.tool_choice).toBe("required");
      }
    }
    expect(
      api === "openai-completions" ? requests[0]?.reasoning_effort : requests[0]?.reasoning?.effort,
    ).toBe(api === "openai-responses" ? expectedResponses : expected);
  });
});
