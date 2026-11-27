import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type OpenAIStrictToolRoute,
} from "../host.js";
import type { Context, Model } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";

// A custom OpenAI-compatible route that declares nothing about strict tools.
const proxyModel = createModel<"openai-completions">({
  id: "proxy-model",
  api: "openai-completions",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
});
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  ],
} satisfies Context;
const reply = `data: ${JSON.stringify({
  id: "chatcmpl-strict",
  object: "chat.completion.chunk",
  model: proxyModel.id,
  choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

// The strict refusal OpenAI returned for an open-map tool schema (captured 2026-11-27).
const strictRefusal = {
  message:
    "Invalid schema for function 'lookup': In context=(), additionalProperties must be false for a strict schema",
  type: "invalid_request_error",
  param: "tools[0].parameters",
  code: "invalid_function_parameters",
};
// Errors that some proxies report as 400; none of them is about strict tools.
const quotaAs400 = {
  message: "You exceeded your current quota, please check your plan and billing details.",
  type: "insufficient_quota",
  code: "insufficient_quota",
};
const authAs400 = {
  message: "Incorrect API key provided.",
  type: "invalid_request_error",
  code: "invalid_api_key",
};
const rateAs400 = {
  message: "Rate limit reached for requests",
  type: "requests",
  code: "rate_limit_exceeded",
};
const genericBadRequest = { message: "Bad request", type: "invalid_request_error" };

/** Refuses the first request with `firstError` (400); answers every later request. */
function install(firstError: Record<string, string>) {
  const sentStrict: boolean[] = [];
  const recorded: OpenAIStrictToolRoute[] = [];
  const learned = new Set<string>();
  const key = (route: OpenAIStrictToolRoute) => JSON.stringify(route);
  configureAiTransportHost({
    buildModelFetch: () => async (_input, init) => {
      const body = JSON.parse(await new Response(init?.body).text()) as {
        tools?: Array<{ function: { strict?: boolean } }>;
      };
      const strict = body.tools?.some((tool) => tool.function.strict === true) ?? false;
      sentStrict.push(strict);
      // A strict refusal repeats for every strict request; other errors happen once.
      const refuse = firstError === strictRefusal ? strict : sentStrict.length === 1;
      return refuse
        ? Response.json({ error: firstError }, { status: 400 })
        : new Response(reply, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    strictToolRejections: {
      has: async (route) => learned.has(key(route)),
      record: async (route) => {
        recorded.push(route);
        const first = !learned.has(key(route));
        learned.add(key(route));
        return first;
      },
    },
  });
  return { sentStrict, recorded };
}

const streamFn = createOpenAICompletionsTransportStreamFn();
async function run(model: Model<"openai-completions">) {
  const stream = streamFn(model, context, { apiKey: "fixture-token" });
  return (await stream).result();
}

let previousHost: ReturnType<typeof getAiTransportHost>;
beforeEach(() => {
  previousHost = getAiTransportHost();
});
afterEach(() => {
  configureAiTransportHost(previousHost);
  vi.restoreAllMocks();
});

it("retries a strict rejection once without strict tools, records it, and skips strict next time", async () => {
  const endpoint = install(strictRefusal);

  expect((await run(proxyModel)).stopReason).toBe("stop");
  expect(endpoint.sentStrict).toEqual([true, false]);
  expect(endpoint.recorded).toEqual([
    {
      provider: proxyModel.provider,
      api: "openai-completions",
      baseUrl: "https://proxy.example/v1",
      model: "proxy-model",
    },
  ]);

  expect((await run(proxyModel)).stopReason).toBe("stop");
  expect(endpoint.sentStrict).toEqual([true, false, false]);
  // Another configured provider on the same URL and model may reach another tenant.
  await run({ ...proxyModel, provider: "proxy-tenant-b" });
  expect(endpoint.sentStrict).toEqual([true, false, false, true, false]);
});

it.each([
  ["quota", quotaAs400],
  ["auth", authAs400],
  ["rate", rateAs400],
  ["a one-off generic", genericBadRequest],
])("never retries or records %s errors reported as 400", async (_name, error) => {
  const endpoint = install(error);

  expect((await run(proxyModel)).stopReason).toBe("error");
  expect(endpoint.sentStrict).toEqual([true]);
  expect(endpoint.recorded).toEqual([]);
  // The next request still sends strict tools and succeeds: nothing was learned.
  expect((await run(proxyModel)).stopReason).toBe("stop");
  expect(endpoint.sentStrict).toEqual([true, true]);
});

it("never retries a route that declares strict support", async () => {
  const endpoint = install(strictRefusal);
  const declared = { ...proxyModel, compat: { supportsStrictMode: true } };

  expect((await run(declared)).stopReason).toBe("error");
  expect(endpoint.sentStrict).toEqual([true]);
  expect(endpoint.recorded).toEqual([]);
});
