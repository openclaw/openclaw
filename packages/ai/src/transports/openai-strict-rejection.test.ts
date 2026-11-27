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

type Endpoint = "rejects-strict" | "rejects-everything";

function install(endpoint: Endpoint) {
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
      return endpoint === "rejects-everything" || strict
        ? Response.json({ error: { message: "invalid request" } }, { status: 400 })
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

it("retries once without strict tools, remembers the route, and skips strict next time", async () => {
  const endpoint = install("rejects-strict");

  expect((await run(proxyModel)).stopReason).toBe("stop");
  expect(endpoint.sentStrict).toEqual([true, false]);
  expect(endpoint.recorded).toEqual([
    { api: "openai-completions", baseUrl: "https://proxy.example/v1", model: "proxy-model" },
  ]);

  expect((await run(proxyModel)).stopReason).toBe("stop");
  expect(endpoint.sentStrict).toEqual([true, false, false]);
});

it("does not learn a rejection that the retry without strict also gets", async () => {
  const endpoint = install("rejects-everything");

  expect((await run(proxyModel)).stopReason).toBe("error");
  expect(endpoint.sentStrict).toEqual([true, false]);
  expect(endpoint.recorded).toEqual([]);
});

it("never retries a route that declares strict support", async () => {
  const endpoint = install("rejects-strict");
  const declared = { ...proxyModel, compat: { supportsStrictMode: true } };

  expect((await run(declared)).stopReason).toBe("error");
  expect(endpoint.sentStrict).toEqual([true]);
  expect(endpoint.recorded).toEqual([]);
});
