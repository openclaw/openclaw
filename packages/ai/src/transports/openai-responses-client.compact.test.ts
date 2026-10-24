import type { Context, Model } from "@openclaw/llm-core";
import { beforeEach, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: Record<string, unknown>) {
      sdkState.clients.push(options);
    }

    post = sdkState.post;
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { resolveOpenAIResponsesCompactEndpointPlan } from "./openai-responses-payload-policy.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
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
  messages: [{ role: "user", content: "Remember NORTH-COPPER-17.", timestamp: 1 }],
} satisfies Context;

const compactionItem = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
const retainedWindow = (content: unknown[], role = "user") => [
  { type: "message", role, content },
  { type: "compaction", encrypted_content: "opaque" },
];
const retainedUser = retainedWindow([{ type: "input_text", text: "Remember NORTH-COPPER-17." }])[0];
function mockCompactResponse(
  output: unknown[],
  usage = { input_tokens: 1, output_tokens: 1 },
): void {
  sdkState.post.mockResolvedValue({ object: "response.compaction", output, usage });
}

function compact(requestModel: Model = model, requestContext = context, sessionId?: string) {
  return requestPreparedOpenAIResponsesCompaction(
    createOpenAIResponsesTransportStreamFn(),
    requestModel,
    requestContext,
    { apiKey: "test-key", sessionId },
  );
}

function expectCompactBody(body: unknown) {
  expect(sdkState.post).toHaveBeenCalledWith(
    "/responses/compact",
    expect.objectContaining({ body }),
  );
}

beforeEach(() => {
  sdkState.clients.length = 0;
  sdkState.post.mockReset();
});

it("sends the system prompt as instructions and accepts retained users from official OpenAI", async () => {
  const usage = { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 };
  mockCompactResponse([retainedUser, compactionItem], usage);
  const result = await compact(officialOpenAIModel, context, "session-1");

  expect(sdkState.clients[0]).toMatchObject({
    apiKey: "test-key",
    baseURL: "https://api.openai.com/v1",
  });
  // The prompt stays out of input, so the endpoint cannot retain it in the window.
  expectCompactBody({
    model: "gpt-5.6-luna",
    instructions: "Retain the conversation.",
    input: [expect.objectContaining({ role: "user", type: "message" })],
  });
  expect(result).toMatchObject({
    output: [expect.objectContaining({ role: "user" }), compactionItem],
    item: compactionItem,
    historyMode: "retained-users",
    usage,
    model: officialOpenAIModel,
    replayMetadata: {
      source: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
    },
  });
});

it.each([
  ["user", [{ type: "input_text", text: "Retained fact." }]],
  ["assistant", [{ type: "output_text", text: "Retained answer.", annotations: [] }]],
] as const)(
  "accepts a canonical retained %s window with fewer users than its input",
  async (role, content) => {
    const output = retainedWindow([...content], role);
    mockCompactResponse(output, { input_tokens: 100, output_tokens: 10 });
    const result = await compact(officialOpenAIModel, {
      ...context,
      messages: [
        ...context.messages,
        { role: "user", content: "A second user message.", timestamp: 2 },
      ],
    });
    expect(result.output).toEqual(output);
    expect(result.historyMode).toBe("retained-users");
    expectCompactBody(
      expect.objectContaining({
        input: [
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "user" }),
        ],
      }),
    );
  },
);

it.each<{ output: unknown[]; reason: string; route?: Model }>([
  {
    output: [{ type: "message", role: "user", content: [] }],
    reason: "must end with a compaction item",
  },
  {
    output: [{ type: "compaction", encrypted_content: "" }],
    reason: "nonempty encrypted_content",
  },
  {
    output: [
      { type: "compaction", encrypted_content: "first" },
      { type: "compaction", encrypted_content: "last" },
    ],
    reason: "exactly one compaction item",
  },
  ...[
    { type: "input_image", detail: "auto" },
    { type: "input_file", file_id: 42 },
    { type: "output_text", text: "not supported input" },
  ].map((block) => ({ output: retainedWindow([block]), reason: "unsupported content" })),
  {
    output: [{ type: "compaction", encrypted_content: "opaque", status: "completed" }],
    reason: rewritten,
    route: customModel,
  },
  ...["data:image/png;base64,invalid", "data:image/png;base64,/9j/"].map((image_url) => ({
    output: retainedWindow([{ type: "input_image", detail: "auto", image_url }]),
    reason: rewritten,
  })),
])(
  "rejects invalid canonical windows: $reason %j",
  async ({ output, reason, route = officialOpenAIModel }) => {
    mockCompactResponse(output);
    await expect(compact(route)).rejects.toThrow(reason);
  },
);

it("rejects retained-message prefixes from native xAI", async () => {
  mockCompactResponse([retainedUser, compactionItem]);

  await expect(compact()).rejects.toThrow("retained messages require native OpenAI");
  // xAI has no instructions field on /responses/compact and disables the developer role.
  expectCompactBody({
    model: "grok-4.5",
    input: [
      expect.objectContaining({ role: "system", type: "message" }),
      expect.objectContaining({ role: "user", type: "message" }),
    ],
  });
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
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }),
    undefined,
    false,
  ],
  [
    "Azure default",
    createRoute({
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com",
    }),
    undefined,
    false,
  ],
] as const)("resolves the %s gate", (_name, route, extraParams, enabled) => {
  expect(resolveOpenAIResponsesCompactEndpointPlan(route, extraParams).enabled).toBe(enabled);
});
