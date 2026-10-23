// Opted-in Claude 5 routes stream before the terminal stop reason; failed calls keep their discard.
import type { AssistantMessageEvent, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  context,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "../provider-transport-parity.test-support.js";
import { streamAnthropic } from "../providers/anthropic.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

registerParityHostLifecycle();

type Wire = Record<string, unknown>;
type Entry = "provider" | "transport";
const entries: Entry[] = ["provider", "transport"];
const PROXY = "https://proxy.example.com/v1";
const OPT_IN = { streamBeforeRefusal: true };

const start = { type: "message_start", message: { id: "msg_live", usage: { input_tokens: 3 } } };
const textStart = (index: number) => ({
  type: "content_block_start",
  index,
  content_block: { type: "text", text: "" },
});
const textDelta = (index: number, text: string) => ({
  type: "content_block_delta",
  index,
  delta: { type: "text_delta", text },
});
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const refusal = [
  {
    type: "message_delta",
    delta: {
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Not allowed." },
    },
    usage: { input_tokens: 3, output_tokens: 2 },
  },
  { type: "message_stop" },
];

function claude(overrides: Partial<Model<"anthropic-messages">>): Model<"anthropic-messages"> {
  return {
    ...anthropicModel,
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    maxTokens: 8192,
    compat: OPT_IN,
    ...overrides,
  };
}

/** An SSE response that stays open after `events` until `finish` writes the rest. */
function heldResponse(events: Wire[]) {
  const encoder = new TextEncoder();
  const frame = (wire: Wire[]) =>
    encoder.encode(
      wire
        .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
  let finish: (rest: Wire[]) => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame(events));
      finish = (rest) => {
        controller.enqueue(frame(rest));
        controller.close();
      };
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    finish: (rest: Wire[]) => finish(rest),
  };
}

async function open(
  entry: Entry,
  model: Model<"anthropic-messages">,
  response: Response,
  options: { apiKey?: string; onPayload?: (payload: unknown) => unknown } = {},
) {
  const apiKey = options.apiKey ?? "sk-ant-api";
  if (entry === "provider") {
    // An injected client cannot opt into beta-gated fallbacks, like any custom endpoint.
    const client = { messages: { create: () => ({ asResponse: async () => response }) } };
    return streamAnthropic(model, context, {
      apiKey,
      client: client as never,
      onPayload: options.onPayload,
    });
  }
  configureAiTransportHost({
    ...getAiTransportHost(),
    buildModelFetch: () => async () => response,
  });
  return createAnthropicMessagesTransportStreamFn()(model, context, {
    apiKey,
    onPayload: options.onPayload,
  });
}

async function drain(events: AsyncIterator<AssistantMessageEvent>) {
  const types: string[] = [];
  for (let next = await events.next(); !next.done; next = await events.next()) {
    types.push(next.value.type);
  }
  return types;
}

describe("Anthropic streaming before the refusal decision", () => {
  it.each(entries)(
    "%s: delivers deltas while the provider holds the stop reason",
    async (entry) => {
      const held = heldResponse([start, textStart(0), textDelta(0, "live answer")]);
      const stream = await open(entry, claude({ baseUrl: PROXY }), held.response);
      const events = stream[Symbol.asyncIterator]();
      const beforeTerminal: string[] = [];
      while (beforeTerminal.at(-1) !== "text_delta") {
        const next = await events.next();
        if (next.done) {
          break;
        }
        beforeTerminal.push(next.value.type);
      }
      held.finish([
        blockStop(0),
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]);

      expect(beforeTerminal).toEqual(["start", "text_start", "text_delta"]);
      expect(await drain(events)).toEqual(["text_end", "done"]);
      expect((await stream.result()).content).toEqual([{ type: "text", text: "live answer" }]);
    },
  );

  // Same frames and diagnostics as the default-route "unsafe partial output" tests.
  it.each([
    { entry: "provider" as const, baseUrl: anthropicModel.baseUrl },
    { entry: "provider" as const, baseUrl: PROXY },
    // OAuth sends no `fallbacks`, so the opt-in applies on the direct endpoint.
    {
      entry: "transport" as const,
      baseUrl: anthropicModel.baseUrl,
      apiKey: "sk-ant-oat01-fixture",
    },
  ])(
    "$entry: discards output streamed before an early end at $baseUrl",
    async ({ entry, baseUrl, apiKey }) => {
      const response = createAnthropicResponse([
        textStart(0),
        textDelta(0, "unsafe partial output"),
      ]);
      const stream = await open(
        entry,
        claude({ id: "claude-fable-5", name: "Claude Fable 5", baseUrl }),
        response,
        { apiKey },
      );

      expect(await drain(stream[Symbol.asyncIterator]())).toEqual([
        "text_start",
        "text_delta",
        "error",
      ]);
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.content).toEqual([]);
      expect(result.errorMessage).toBe("Anthropic stream ended before message_stop");
    },
  );

  it.each(entries)("%s: discards output streamed before a refusal", async (entry) => {
    const response = createAnthropicResponse([
      start,
      textStart(0),
      textDelta(0, "discard this partial output"),
      blockStop(0),
      ...refusal,
    ]);
    const stream = await open(entry, claude({ baseUrl: PROXY }), response);

    expect(await drain(stream[Symbol.asyncIterator]())).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    const result = await stream.result();
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toBe("Anthropic refusal (category: cyber): Not allowed.");
    expect(result.usage).toMatchObject({ input: 3, output: 2 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_refusal",
        details: { provider: "anthropic", category: "cyber", explanation: "Not allowed." },
      }),
    ]);
  });

  it.each(entries)("%s: never seals a complete tool call that a refusal ends", async (entry) => {
    const response = createAnthropicResponse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_refused", name: "lookup", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
      },
      blockStop(0),
      ...refusal,
    ]);
    const stream = await open(entry, claude({ baseUrl: PROXY }), response);

    // Execution starts only from toolcall_end, which needs a successful stop reason.
    expect(await drain(stream[Symbol.asyncIterator]())).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "error",
    ]);
    expect((await stream.result()).content).toEqual([]);
  });

  // A fallback boundary rewrites delivered blocks, so a request naming `fallbacks` keeps deferring.
  it.each(entries)("%s: defers a request that names server-side fallbacks", async (entry) => {
    const response = createAnthropicResponse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } },
      blockStop(0),
      textStart(1),
      textDelta(1, "partial "),
      blockStop(1),
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "fallback",
          from: { model: "claude-sonnet-5-5" },
          to: { model: "claude-sonnet-5" },
        },
      },
      blockStop(2),
      textStart(3),
      textDelta(3, "continued"),
      blockStop(3),
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);
    // The transport sends `fallbacks` on direct API-key requests; the provider entry adds it by hook.
    const stream = await open(entry, claude({}), response, {
      onPayload:
        entry === "provider"
          ? (payload) => Object.assign({}, payload, { fallbacks: "default" })
          : undefined,
    });

    const types = await drain(stream[Symbol.asyncIterator]());
    expect(types).not.toContain("thinking_start");
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect((await stream.result()).content).toEqual([
      { type: "text", text: "partial " },
      { type: "text", text: "continued" },
    ]);
  });
});
