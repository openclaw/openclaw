import type { Context, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createZeroUsage } from "../usage.test-support.js";
import type { AnthropicTransportOptions } from "./anthropic-transport-options.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
  type AnthropicMessagesModel,
} from "./anthropic-transport-stream.test-support.js";

const buildGuardedModelFetchMock = vi.fn();
const guardedFetchMock = vi.fn();
const coreTransportHost = getAiTransportHost();

type AnthropicStreamOptions = SimpleStreamOptions & AnthropicTransportOptions;

function latestPayload(): Record<string, unknown> {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as Record<
    string,
    unknown
  >;
}

async function run(
  model: AnthropicMessagesModel,
  context: Context,
  options: AnthropicStreamOptions,
) {
  return (await createAnthropicMessagesTransportStreamFn()(model, context, options)).result();
}

beforeEach(() => {
  installAnthropicTransportTestHost({
    coreTransportHost,
    buildModelFetch: buildGuardedModelFetchMock,
    guardedFetch: guardedFetchMock,
  });
});

afterAll(() => {
  configureAiTransportHost(coreTransportHost);
});

it("prewarms the cache with the unchanged request, no output and no checkpoint on its trailing item", async () => {
  const context: Context = {
    systemPrompt: "Be brief.",
    messages: [
      makeUserMessage("history", 0),
      {
        role: "assistant",
        content: [{ type: "text", text: "noted" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: createZeroUsage(),
        stopReason: "stop",
        timestamp: 1,
      },
      makeUserMessage(".", 2),
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
  } as Context;
  const options: AnthropicStreamOptions = { apiKey: "sk-ant-api", cacheRetention: "long" };
  await run(makeAnthropicTransportModel(), context, options);
  const normal = latestPayload();
  guardedFetchMock.mockResolvedValueOnce(
    Response.json({
      id: "msg_prewarm",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: "max_tokens",
      usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 900 },
    }),
  );
  const result = await run(makeAnthropicTransportModel(), context, {
    ...options,
    cachePrewarm: true,
  });

  // The trailing item carries no checkpoint, so its single text block goes out as a string.
  const messages = normal.messages as unknown[];
  expect(latestPayload()).toEqual({
    ...normal,
    max_tokens: 0,
    stream: false,
    messages: [...messages.slice(0, -1), { role: "user", content: "." }],
  });
  expect(result.stopReason).toBe("stop");
  expect(result.content).toEqual([]);
  expect(result.usage.cacheRead).toBe(900);
  expect(result.usage.output).toBe(0);
});

it("refuses a prewarm that budget thinking would turn into a different request", async () => {
  const result = await run(
    makeAnthropicTransportModel({ id: "claude-sonnet-4-5", reasoning: true }),
    { messages: [makeUserMessage("hello", 0)] },
    { apiKey: "sk-ant-api", cachePrewarm: true, reasoning: "medium" },
  );
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("budget thinking");
  expect(guardedFetchMock).not.toHaveBeenCalled();
});
