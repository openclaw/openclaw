import type { Context, Model, UserMessage } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { convertMessages } from "../../../../packages/ai/src/openai-completions-messages.js";
import { buildAnthropicRequest } from "../../../../packages/ai/src/transports/anthropic-messages.js";
import { resolveOpenAICompletionsCompat } from "../../../../packages/ai/src/transports/openai-completions-compat.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { buildCopilotDynamicHeaders } from "../../copilot-dynamic-headers.js";
import { resolveProviderRequestCapabilities } from "../../provider-attribution.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";

const model: Model = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};
const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });
const current = user("CURRENT user text");
const carrier: UserMessage = {
  ...user("OpenClaw runtime context: CTX"),
  runtimeContext: { retained: false },
};
const history: Context["messages"] = [
  user("Earlier question"),
  makeAgentAssistantMessage({ content: [{ type: "text", text: "Earlier answer" }] }),
  current,
];

function sanitize(
  activeModel: Model,
  messages: Context["messages"] = [...history, carrier],
): Context {
  let sent: Context = { messages: [] };
  const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
    (_model, context) => {
      sent = context;
      return undefined as never;
    },
    new Set(["lookup"]),
    {
      validateAnthropicTurns: true,
      validateGeminiTurns: false,
      preserveSignatures: false,
      dropThinkingBlocks: false,
      appendOnlyRuntimeContext: false,
    },
    activeModel.provider,
  );
  void wrapped(activeModel, { messages });
  return sent;
}

it.each([
  { baseUrl: "https://api.openai.com/v1", carrierRole: "developer" },
  { baseUrl: "http://127.0.0.1:11434/v1", carrierRole: "user" },
])("keeps ordinary input separate from the $carrierRole carrier at $baseUrl", (route) => {
  const activeModel = { ...model, baseUrl: route.baseUrl };
  const optOut = new Set<number>();
  const wire = convertMessages(
    activeModel,
    sanitize(activeModel),
    resolveOpenAICompletionsCompat(activeModel, resolveProviderRequestCapabilities),
    { cacheOptOutIndexes: optOut },
  );
  expect(JSON.stringify(wire)).toBe(
    JSON.stringify([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: current.content },
      { role: route.carrierRole, content: carrier.content },
    ]),
  );
  expect([...optOut]).toEqual([3]);
});

it("keeps the user's Anthropic cache breakpoint and bytes through a tool loop", async () => {
  const activeModel: Model<"anthropic-messages"> = {
    ...model,
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
  };
  const request = async (messages: Context["messages"]) =>
    (
      await buildAnthropicRequest(
        activeModel,
        sanitize(activeModel, messages),
        { cacheRetention: "short" },
        "provider",
        false,
        false,
      )
    ).params.messages;
  const first = await request([current, carrier]);
  const second = await request([
    current,
    makeAgentAssistantMessage({
      api: "anthropic-messages",
      provider: "anthropic",
      model: activeModel.id,
      content: [{ type: "toolCall", id: "lookup_1", name: "lookup", arguments: {} }],
      stopReason: "toolUse",
    }),
    makeTextToolResult("lookup_1", "lookup", "Tool answer", false, 2),
    carrier,
  ]);
  const expectedUser = {
    role: "user",
    content: [{ type: "text", text: current.content, cache_control: { type: "ephemeral" } }],
  };
  expect(JSON.stringify(first)).toBe(
    JSON.stringify([expectedUser, { role: "user", content: carrier.content }]),
  );
  expect(second[0]).toEqual(expectedUser);
  expect(second.at(-1)).toEqual(first[1]);
  expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]));
});

it("keeps Copilot's x-initiator user fact after an earlier completed turn", () => {
  const activeModel = { ...model, api: "anthropic-messages", provider: "github-copilot" };
  expect(
    buildCopilotDynamicHeaders({
      messages: sanitize(activeModel).messages,
      hasImages: false,
    })["x-initiator"],
  ).toBe("user");
});

it("keeps synthetic context rows and stored input media facts separate", () => {
  const summary: UserMessage = { ...user("Compaction summary"), synthetic: true };
  const kept = user("Kept input");
  expect(sanitize(model, [summary, kept]).messages).toEqual([summary, kept]);
  const withMedia = { ...kept, __openclaw: { mediaFacts: [{ path: "stored.png" }] } };
  const extension: UserMessage = { ...user("Extension context"), synthetic: true };
  expect(sanitize(model, [withMedia, extension]).messages).toEqual([withMedia, extension]);
});

it("keeps user rows separate until provider media materialization, including Bedrock", () => {
  const update: UserMessage = { ...user("Operator update"), operatorMessage: { turnScoped: true } };
  expect(sanitize(model, [current, update, user("Steering")]).messages).toEqual([
    current,
    update,
    user("Steering"),
  ]);
  expect(
    sanitize({ ...model, api: "bedrock-converse-stream" }, [current, carrier]).messages,
  ).toEqual([current, carrier]);
});
