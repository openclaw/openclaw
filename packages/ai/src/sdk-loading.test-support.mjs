import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";

const [family, mode] = process.argv.slice(2);
const anthropic = family.startsWith("anthropic");
const injected = family === "anthropic-injected";
const websocket = family === "websocket";
const target = websocket
  ? "openai/resources/responses/ws.js"
  : injected
    ? "@anthropic-ai/sdk/core/streaming.js"
    : anthropic
      ? "@anthropic-ai/sdk"
      : "openai";
const controller = new AbortController();
const loaded = new Set();
let armed = false;
let triggered = false;
let current = true;
let payloads = 0;
let requests = 0;
let connections = 0;
let settled = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /^(openai|@anthropic-ai\/sdk|@google\/genai|@mistralai\/mistralai|ws)(\/|$)/.test(specifier)
    ) {
      assert(armed, `eager implementation: ${specifier}`);
      const allowed = anthropic
        ? specifier.startsWith("@anthropic-ai/sdk") &&
          (!injected || specifier !== "@anthropic-ai/sdk")
        : specifier === "openai" || (websocket && (specifier === target || specifier === "ws"));
      assert(allowed, `unselected implementation: ${specifier}`);
      loaded.add(specifier);
      if (specifier === target && !triggered) {
        triggered = true;
        if (mode === "reject") {
          throw new Error("cold-load-import-rejected");
        }
        if (mode === "abort") {
          controller.abort(new Error("cold-load-aborted"));
        }
        if (mode === "revoke") {
          current = false;
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const transports = await import("@openclaw/ai/transports");
const openai = await import("@openclaw/ai/internal/openai");
const claude = await import("@openclaw/ai/internal/anthropic");
const { configureAiTransportHost } = await import("@openclaw/ai");
const { cleanupSessionResources } = await import("@openclaw/ai/internal/runtime");
if (family === "helpers") {
  assert.equal(openai.clampOpenAIPromptCacheKey("x".repeat(65)), "x".repeat(64));
  assert.equal(
    claude.findActiveAnthropicToolTurnAssistantIndex([
      { role: "assistant", content: [{ type: "toolCall", id: "call-fixture" }] },
      { role: "toolResult", toolCallId: "call-fixture" },
    ]),
    0,
  );
  assert.equal(
    transports.isCompactionReplayCheckpoint({
      type: "openai-responses-compaction",
      data: "synthetic-checkpoint",
    }),
    true,
  );
  assert.equal(typeof transports.createOpenAIResponsesTransportStreamFn(), "function");
  assert.deepEqual([...loaded], []);
} else {
  const model = {
    id: anthropic ? "claude-sonnet-4-6" : "scripted-model",
    name: "Scripted model",
    provider: anthropic
      ? "anthropic"
      : family === "transport-azure"
        ? "azure-openai-responses"
        : "openai",
    api: anthropic
      ? "anthropic-messages"
      : family.includes("completions")
        ? "openai-completions"
        : family === "transport-azure"
          ? "azure-openai-responses"
          : "openai-responses",
    baseUrl: anthropic
      ? "https://api.anthropic.com"
      : family === "transport-azure"
        ? "https://fixture.openai.azure.com/openai"
        : "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const text = { type: "output_text", text: "fixture-ok", annotations: [] };
  const item = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [text],
  };
  const events = anthropic
    ? [
        {
          type: "message_start",
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: model.id,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fixture-ok" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]
    : family.includes("completions")
      ? [
          {
            id: "completion_fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "fixture-ok" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "completion_fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          },
        ]
      : [
          { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
          {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { ...text, text: "" },
          },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: text.text,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_fixture",
              status: "completed",
              output: [item],
              usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            },
          },
        ];
  const body =
    events
      .map(
        (event) => `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join("") + (family.includes("completions") ? "data: [DONE]\n\n" : "");
  const fetch = async (input, init) => {
    requests++;
    assert.equal(mode, "success", "closed preparation reached provider egress");
    if (family === "transport-azure") {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      assert.equal(url.pathname, "/openai/responses");
      assert(url.searchParams.has("api-version"));
      assert.equal(headers.get("api-key"), "synthetic-fixture-only");
      assert.equal(headers.has("authorization"), false);
    }
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  configureAiTransportHost({ buildModelFetch: () => fetch });
  const options = {
    apiKey: "synthetic-fixture-only",
    signal: controller.signal,
    transport: websocket ? "auto" : "sse",
    onPayload() {
      payloads++;
    },
    ...(injected ? { client: { messages: { create: () => ({ asResponse: fetch }) } } } : {}),
  };
  if (family === "transport-responses" || websocket) {
    openai.responsesRequestLifecycle.set(options, {
      async beforeDispatch() {
        assert(current, "cold-load-revoked");
      },
      assertCurrent() {
        assert(current, "cold-load-revoked");
      },
      async accepted() {},
      async settle() {
        settled++;
      },
    });
  }
  const streamFn = anthropic
    ? claude.streamAnthropic
    : family === "provider-completions"
      ? openai.streamOpenAICompletions
      : family === "provider-responses"
        ? openai.streamOpenAIResponses
        : family === "transport-completions"
          ? transports.createOpenAICompletionsTransportStreamFn()
          : family === "transport-azure"
            ? transports.createAzureOpenAIResponsesTransportStreamFn()
            : transports.createOpenAIResponsesTransportStreamFn();
  // An unexpected WS connection must fail locally, not escape the fetch fixture.
  const connect = Object.getOwnPropertyDescriptor(Socket.prototype, "connect");
  assert(connect);
  Socket.prototype.connect = function () {
    connections++;
    throw new Error("unexpected socket connection");
  };
  try {
    armed = true;
    const stream = streamFn(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      options,
    );
    assert.equal(typeof stream.result, "function");
    assert.equal(stream instanceof Promise, false);
    const result = await stream.result();
    assert(triggered, `cold load did not reach ${target}`);
    if (mode === "success") {
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        "fixture-ok",
      );
      assert.equal(payloads, 1);
      assert.equal(requests, 1);
    } else {
      assert.equal(result.stopReason, mode === "abort" ? "aborted" : "error");
      assert.match(
        result.errorMessage,
        new RegExp(
          `cold-load-${mode === "reject" ? "import-rejected" : mode === "revoke" ? "revoked" : "aborted"}`,
        ),
      );
      assert.equal(payloads, 0);
      assert.equal(requests, 0);
    }
    assert.equal(connections, 0);
    if (family === "transport-responses" || websocket) {
      assert.equal(settled, mode === "success" ? 0 : 1);
    }
  } finally {
    cleanupSessionResources();
    Object.defineProperty(Socket.prototype, "connect", connect);
    configureAiTransportHost({});
  }
}
console.log(
  JSON.stringify({
    family,
    mode,
    passed: true,
    loaded: [...loaded],
    payloads,
    requests,
    connections,
    settled,
  }),
);
