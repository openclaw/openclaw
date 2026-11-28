import type { Context, Model } from "@openclaw/llm-core";
import { beforeEach, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    post = sdkState.post;
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { captureOpenAIResponsesCompaction } from "./openai-responses-compaction-replay.js";
import { resolveOpenAIResponsesCompactEndpointPlan } from "./openai-responses-payload-policy.js";
import {
  createAssistant,
  createModel,
  outputMessage,
  userMessage,
} from "./openai-responses-prompt-observer.test-support.js";
import {
  createOpenAIResponsesTransportStreamFn,
  requestPreparedOpenAIResponsesCompaction,
} from "./openai-responses-transport.js";

const model = createModel({
  id: "grok-4.5",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
});

const officialOpenAIModel = {
  ...model,
  id: "gpt-5.6-luna",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} satisfies Model<"openai-responses">;
const customModel = { ...model, provider: "custom", baseUrl: "https://responses.example/v1" };
const rewritten = "rewritten by the Responses payload policy";
const context = {
  systemPrompt: "Retain the conversation.",
  messages: [userMessage("Remember NORTH-COPPER-17."), userMessage("A second user message.", 2)],
} satisfies Context;

const compactionItem = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
const retainedWindow = (content: unknown[], role = "user") => [
  { type: "message", role, content },
  { type: "compaction", encrypted_content: "opaque" },
];
const retainedUser = retainedWindow([{ type: "input_text", text: "Remember NORTH-COPPER-17." }])[0];
function mockCompactResponse(
  output: unknown[],
  usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 1 },
): void {
  sdkState.post.mockResolvedValue({ object: "response.compaction", output, usage });
}

function compact(
  requestModel: Model = model,
  requestContext: Context = context,
  sessionId?: string,
  onPayload?: (payload: unknown) => unknown,
) {
  return requestPreparedOpenAIResponsesCompaction(
    createOpenAIResponsesTransportStreamFn(),
    requestModel,
    requestContext,
    { apiKey: "test-key", sessionId, onPayload },
  );
}

function expectCompactBody(body: unknown) {
  expect(sdkState.post).toHaveBeenCalledWith(
    "/responses/compact",
    expect.objectContaining({ body }),
  );
}

beforeEach(() => sdkState.post.mockReset());

it.each([
  ["instructions", officialOpenAIModel],
  // Normal requests carry this prompt in input; the compact call must still keep it out.
  ["an input item", { ...officialOpenAIModel, compat: { cachesInstructions: false } }],
])("keeps a prompt sent as %s outside the retained window", async (_name, requestModel) => {
  const usage = { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 };
  const output = [retainedUser, outputMessage("Retained answer."), compactionItem];
  mockCompactResponse(output, usage);
  const result = await compact(requestModel, context, "session-1", (payload) =>
    structuredClone(payload),
  );

  // The prompt stays out of input, so the endpoint cannot retain it in the window.
  expectCompactBody({
    model: "gpt-5.6-luna",
    instructions: "Retain the conversation.",
    input: context.messages.map(() => expect.objectContaining({ role: "user", type: "message" })),
  });
  expect(result).toMatchObject({
    item: compactionItem,
    historyMode: "retained-users",
    usage,
    model: requestModel,
    replayMetadata: {
      source: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
    },
  });
  expect(result.output).toEqual(output);
});

it("respects a native model that explicitly opts out of instructions", async () => {
  mockCompactResponse([compactionItem]);
  await compact({
    ...officialOpenAIModel,
    reasoning: true,
    compat: { supportsInstructions: false, cachesInstructions: false },
  });
  expectCompactBody({
    model: "gpt-5.6-luna",
    input: [
      expect.objectContaining({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: context.systemPrompt }],
      }),
      ...context.messages.map(() => expect.objectContaining({ role: "user" })),
    ],
  });
});

it("prices the compact call with the normal Responses usage buckets", async () => {
  mockCompactResponse([compactionItem], {
    input_tokens: 120_000,
    output_tokens: 4_000,
    input_tokens_details: { cached_tokens: 20_000 },
    output_tokens_details: { reasoning_tokens: 1_500 },
  });
  const pricedModel = { ...model, cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } };

  const result = await compact(pricedModel);

  // Run accounting treats a call without cost as making the whole run's cost unavailable.
  expect(result.modelUsage).toMatchObject({
    input: 100_000,
    cacheRead: 20_000,
    output: 4_000,
    reasoningTokens: 1_500,
    usageReport: { state: "available" },
    cost: { input: 0.2, output: 0.032, cacheRead: 0.01 },
  });
  expect(result.modelUsage?.cost.total).toBeCloseTo(0.242, 10);
});

it.each<{ output: unknown[]; reason: string }>([
  {
    output: [{ type: "message", role: "user", content: [] }],
    reason: "must end with a compaction item",
  },
  {
    output: [{ type: "compaction", encrypted_content: "" }],
    reason: "nonempty encrypted_content",
  },
  {
    output: [compactionItem, compactionItem],
    reason: "exactly one compaction item",
  },
  ...[
    { type: "input_image", detail: "auto" },
    { type: "input_file", file_id: 42 },
    { type: "output_text", text: "not supported input" },
  ].map((block) => ({ output: retainedWindow([block]), reason: "unsupported content" })),
  ...["data:image/png;base64,invalid", "data:image/png;base64,/9j/"].map((image_url) => ({
    output: retainedWindow([{ type: "input_image", detail: "auto", image_url }]),
    reason: rewritten,
  })),
])("rejects invalid canonical windows: $reason %j", async ({ output, reason }) => {
  mockCompactResponse(output);
  await expect(compact(officialOpenAIModel)).rejects.toThrow(reason);
});

it("rejects retained-message prefixes from native xAI", async () => {
  mockCompactResponse([retainedUser, compactionItem]);

  await expect(compact()).rejects.toThrow("retained messages require native OpenAI");
  // xAI has no instructions field on /responses/compact and disables the developer role.
  expectCompactBody({
    model: "grok-4.5",
    input: [
      expect.objectContaining({ role: "system", type: "message" }),
      expect.objectContaining({ role: "user", type: "message" }),
      expect.objectContaining({ role: "user", type: "message" }),
    ],
  });
});

it("keeps the system prompt first on repeated xAI compaction without instructions support", async () => {
  const route = {
    ...model,
    compat: { supportsInstructions: false, supportsDeveloperRole: false },
  };
  const sessionId = "xai-compact-replay";
  mockCompactResponse([compactionItem]);
  const first = await compact(route, context, sessionId);
  const owner = createAssistant(route);
  captureOpenAIResponsesCompaction(owner, first.item, 0, route, first.replayMetadata, first.output);
  await compact(
    route,
    { ...context, messages: [owner, userMessage("New question.", 3)] },
    sessionId,
    (payload) => structuredClone(payload),
  );

  expect(sdkState.post).toHaveBeenCalledTimes(2);
  expect(sdkState.post).toHaveBeenLastCalledWith(
    "/responses/compact",
    expect.objectContaining({
      body: {
        model: "grok-4.5",
        input: [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: "Retain the conversation." }],
          },
          expect.objectContaining({ type: "compaction", encrypted_content: "opaque" }),
          expect.objectContaining({ role: "user" }),
        ],
      },
    }),
  );
});

const createRoute = (overrides: Partial<Model>) => ({ ...officialOpenAIModel, ...overrides });
it.each([
  ["native xAI alias default", { ...model, provider: "x-ai" }, undefined, true],
  ["public OpenAI default", officialOpenAIModel, undefined, true],
  ["public OpenAI opt-out", officialOpenAIModel, { responsesCompactEndpoint: false }, false],
  ["custom Responses opt-in", customModel, { responsesCompactEndpoint: true }, true],
  ["OpenAI without a resolved endpoint", createRoute({ baseUrl: undefined }), undefined, false],
  [
    "ChatGPT default",
    createRoute({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com",
    }),
    undefined,
    false,
  ],
  [
    "Azure default",
    createRoute({
      provider: "azure-openai",
      baseUrl: "https://x.openai.azure.com",
    }),
    undefined,
    false,
  ],
] as const)("resolves the %s gate", (_name, route, extraParams, enabled) => {
  expect(resolveOpenAIResponsesCompactEndpointPlan(route, extraParams).enabled).toBe(enabled);
});
