import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel, preserveTransportHost } from "./openai-provider.test-support.js";

const model = makeOpenAIProviderModel("openai-completions", {
  cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
});

const context = {
  messages: [{ role: "user", content: "Explain the billing", timestamp: 1 }],
} satisfies Context;

const tieredCost = {
  ...model.cost,
  tieredPricing: [
    { ...model.cost, range: [0, 101] as [number, number] },
    { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [101] as [number] },
  ],
};

type UsageScenario = {
  name: string;
  package?: boolean;
  usage?: Record<string, unknown>;
  expectedUsage: Record<string, unknown>;
  expectedCost?: number;
  cost?: typeof model.cost | typeof tieredCost;
  inChoice?: boolean;
  interrupted?: boolean;
  failureAfterTerminal?: boolean;
};

function wireUsage(
  prompt_tokens: number,
  completion_tokens: number,
  details: Record<string, unknown> = {},
) {
  const total_tokens = prompt_tokens + completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens, ...details };
}

function tokenBuckets(input: number, output: number, cacheRead: number, cacheWrite: number) {
  const totalTokens = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function usageCase(
  name: string,
  usage: UsageScenario["usage"],
  expectedUsage: UsageScenario["expectedUsage"],
  options: Partial<UsageScenario> = {},
): UsageScenario {
  return { name, usage, expectedUsage, ...options };
}

const unavailable = { state: "unavailable" };
const available = { state: "available" };
const scenarios: UsageScenario[] = [
  usageCase(
    "transport failure after terminal accounting",
    wireUsage(20, 3),
    { usageReport: available, input: 20, output: 3, totalTokens: 23 },
    { package: true, failureAfterTerminal: true },
  ),
  ...[undefined, wireUsage(20, 3)].map((usage) => ({
    name: usage ? "interruption after provisional usage" : "interruption before usage",
    package: true,
    interrupted: true,
    usage,
    expectedUsage: { usageReport: unavailable, contextUsage: unavailable },
  })),
  usageCase(
    "successful stream without usage",
    undefined,
    { ...tokenBuckets(0, 0, 0, 0), contextUsage: unavailable, usageReport: unavailable },
    { package: true },
  ),
  usageCase(
    "explicit coherent zero usage",
    wireUsage(0, 0),
    {
      totalTokens: 0,
      usageReport: available,
      cacheTelemetry: unavailable,
      contextUsage: { state: "available", promptTokens: 0, totalTokens: 0 },
    },
    { package: true },
  ),
  usageCase(
    "documented reasoning tokens and cache buckets",
    wireUsage(100, 20, {
      prompt_tokens_details: { cached_tokens: 25, cache_write_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 7 },
    }),
    {
      ...tokenBuckets(65, 20, 25, 10),
      cacheTelemetry: available,
      reasoningTokens: 7,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 120 },
    },
    { package: true, expectedCost: 0.00011625 },
  ),
  usageCase(
    "compatible nested cache-creation tokens",
    wireUsage(100, 20, {
      prompt_tokens_details: { cached_tokens: 25, cache_creation_input_tokens: 10 },
    }),
    tokenBuckets(65, 20, 25, 10),
    { expectedCost: 0.00011625 },
  ),
  ...(
    [
      ["below tier boundary", 100, 0, 0, 0.00014],
      ["at tier boundary", 101, 0, 0, 0.000423],
      ["cached input crossing tier boundary", 101, 76, 0, 0.000271],
      ["fully cached tier", 101, 101, 0, 0.000221],
      ["cache writes crossing tier boundary", 101, 25, 51, 0.000322],
    ] as const
  ).map(([name, prompt, cached, written, cost]) => ({
    name,
    cost: tieredCost,
    usage: wireUsage(prompt, 20, {
      prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    }),
    expectedUsage: tokenBuckets(prompt - cached - written, 20, cached, written),
    expectedCost: cost,
  })),
  ...[0, 0.0009].map((billedCost) => ({
    name: `provider-billed ${billedCost} overrides tier estimate`,
    cost: tieredCost,
    usage: wireUsage(101, 20, { prompt_tokens_details: { cached_tokens: 76 }, cost: billedCost }),
    expectedUsage: {
      ...tokenBuckets(25, 20, 76, 0),
      cost: { total: billedCost, totalOrigin: "provider-billed" },
    },
    expectedCost: billedCost,
  })),
  usageCase(
    "explicit zero reasoning tokens",
    wireUsage(10, 5, { completion_tokens_details: { reasoning_tokens: 0 } }),
    { input: 10, output: 5, reasoningTokens: 0, totalTokens: 15 },
  ),
  usageCase(
    "compatible prompt-cache-hit fallback",
    wireUsage(100, 20, { prompt_cache_hit_tokens: 25 }),
    tokenBuckets(75, 20, 25, 0),
    { expectedCost: 0.00012125 },
  ),
  ...(
    [
      ["top-level cached tokens", 25, 25, undefined],
      ["nested cache takes precedence", 25, 90, 25],
      ["nested zero takes precedence", 0, 25, 0],
    ] as const
  ).map(([name, cached, fallback, nested]) => ({
    name,
    package: true,
    usage: wireUsage(100, 20, {
      cached_tokens: fallback,
      ...(nested === undefined ? {} : { prompt_tokens_details: { cached_tokens: nested } }),
    }),
    expectedUsage: {
      input: 100 - cached,
      cacheRead: cached,
      cacheTelemetry: available,
      totalTokens: 120,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 120 },
    },
    expectedCost: (100 - cached + 40 + cached * 0.25) / 1_000_000,
  })),
  usageCase(
    "invalid provider cost and cached-token overflow",
    wireUsage(2, 5, { prompt_tokens_details: { cached_tokens: 4 }, cost: -1 }),
    { ...tokenBuckets(0, 5, 4, 0), contextUsage: unavailable },
    { expectedCost: 0.000011 },
  ),
  usageCase(
    "provider-compatible usage nested in a choice",
    wireUsage(20, 10, {
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 3 },
    }),
    { input: 15, output: 10, cacheRead: 5, reasoningTokens: 3, totalTokens: 30 },
    { package: true, inChoice: true },
  ),
];

function installUsageChunk(
  scenario: Pick<UsageScenario, "usage" | "inChoice" | "interrupted" | "failureAfterTerminal">,
): void {
  const chunk = {
    id: "chatcmpl-usage",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Usage preserved." },
        finish_reason: scenario.interrupted ? null : "stop",
        ...(scenario.inChoice ? { usage: scenario.usage } : {}),
      },
    ],
    ...(scenario.inChoice ? {} : { usage: scenario.usage }),
  };
  const body = `data: ${JSON.stringify(chunk)}\n\n${scenario.interrupted || scenario.failureAfterTerminal ? "" : "data: [DONE]\n\n"}`;
  let emitted = false;
  const responseBody = scenario.failureAfterTerminal
    ? new ReadableStream(
        {
          pull(controller) {
            if (emitted) {
              controller.error(new Error("Fixture connection closed after terminal accounting"));
            } else {
              emitted = true;
              controller.enqueue(new TextEncoder().encode(body));
            }
          },
        },
        { highWaterMark: 0 },
      )
    : body;
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(responseBody, { headers: { "content-type": "text/event-stream" } }),
  });
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createFixtureStream(requestModel: Model<"openai-completions">, managed = true) {
  const options = {
    apiKey: "fixture-token",
    ...(managed ? { reasoning: "medium" as const } : { reasoningEffort: "medium" as const }),
  };
  const provider = managed ? createManagedStream : streamOpenAICompletions;
  const stream = provider(requestModel, context, options);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat Completions transport must return its stream synchronously");
  }
  return stream;
}

preserveTransportHost();

it.each([
  { name: "custom endpoint without usage", warns: 1 },
  { name: "custom endpoint with usage enabled", supportsUsageInStreaming: true, warns: 0 },
  { name: "custom endpoint reporting usage", usage: wireUsage(10, 5), warns: 0 },
  { name: "local endpoint with usage disabled", endpointClass: "local", warns: 0 },
])("emits one actionable hint for $name", async (scenario) => {
  installUsageChunk(scenario);
  const logWarn = vi.fn();
  const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
  configureAiTransportHost({
    ...getAiTransportHost(),
    resolveProviderRequestCapabilities: () => ({
      ...capabilities,
      endpointClass: scenario.endpointClass ?? "custom",
    }),
    logWarn,
  });
  const requestModel = {
    ...model,
    id: scenario.name,
    provider: "usage-hint",
    baseUrl: "https://llm.example.com/v1",
    compat: { supportsUsageInStreaming: scenario.supportsUsageInStreaming ?? false },
  };
  expect((await createFixtureStream(requestModel).result()).stopReason).toBe("stop");
  expect((await createFixtureStream(requestModel).result()).stopReason).toBe("stop");
  expect(logWarn).toHaveBeenCalledTimes(scenario.warns);
  if (scenario.warns) {
    expect(logWarn).toHaveBeenCalledWith(
      "openai-transport",
      expect.stringContaining("set compat.supportsUsageInStreaming: true"),
      { provider: requestModel.provider, model: requestModel.id },
    );
  }
});

describe.each(["package", "managed"])("%s Chat Completions usage", (name) => {
  const ownerScenarios =
    name === "package" ? scenarios.filter((scenario) => scenario.package) : scenarios;
  it.each(ownerScenarios)("preserves $name", async (scenario) => {
    installUsageChunk(scenario);
    const result = await createFixtureStream(
      { ...model, cost: scenario.cost ?? model.cost },
      name === "managed",
    ).result();
    const expectedUsage = { ...scenario.expectedUsage };
    if (name === "package") {
      delete expectedUsage.reasoningTokens;
      expect(result.usage).not.toHaveProperty("reasoningTokens");
    }

    expect(result.stopReason).toBe(
      scenario.interrupted || scenario.failureAfterTerminal ? "error" : "stop",
    );
    expect(result.usage).toMatchObject(expectedUsage);
    if (scenario.expectedCost !== undefined) {
      expect(result.usage.cost.total).toBeCloseTo(scenario.expectedCost, 10);
    }
  });
});
