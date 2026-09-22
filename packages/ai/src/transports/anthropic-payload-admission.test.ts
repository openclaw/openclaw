import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamSimpleAnthropic } from "../providers/anthropic.js";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import { createNormalizingPayloadHook } from "../utils/provider-payload.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

const originalHost = getAiTransportHost();
const fetchMock = vi.fn<typeof fetch>();
const bodies: unknown[] = [];
const headers: Headers[] = [];
const model: Model<"anthropic-messages"> = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 128_000,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

beforeEach(() => {
  bodies.length = 0;
  headers.length = 0;
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected the real adapter's serialized request body");
    }
    bodies.push(JSON.parse(init.body));
    headers.push(new Headers(init.headers));
    const events = [
      {
        type: "message_start",
        message: { id: "fixture", usage: { input_tokens: 0, output_tokens: 0 } },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  configureAiTransportHost({ ...originalHost, buildModelFetch: () => fetchMock });
});
afterEach(() => configureAiTransportHost(originalHost));

describe.each(["sdk", "managed"] as const)("Anthropic %s payload admission", (adapter) => {
  const run = async (options: SimpleStreamOptions) => {
    const stream =
      adapter === "sdk"
        ? streamSimpleAnthropic(model, context, options)
        : await createAnthropicMessagesTransportStreamFn()(model, context, options);
    return stream.result();
  };

  it("normalizes adaptive thinking before detached final payload admission", async () => {
    let admitted: unknown;
    const result = await run({
      apiKey: "synthetic-not-a-secret",
      reasoning: "high",
      onPayload: createNormalizingPayloadHook((payload, _model, normalize) => {
        const snapshot = structuredClone(normalize(payload));
        if (!snapshot || typeof snapshot !== "object" || !("thinking" in snapshot)) {
          throw new Error("Missing adaptive request");
        }
        Object.freeze(snapshot.thinking);
        admitted = Object.freeze(snapshot);
        return admitted;
      }),
    });
    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual([admitted]);
    expect(admitted).toMatchObject({
      stream: true,
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    });
    expect(headers[0]?.get("anthropic-beta")).toContain("thinking-binding-controls-");
  });

  it("preserves ordinary hook replacement semantics", async () => {
    let replacement: object | undefined;
    const result = await run({
      apiKey: "synthetic-not-a-secret",
      reasoning: "high",
      onPayload: (payload) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Missing request");
        }
        replacement = { ...payload, stream: false, temperature: 0.2 };
        return replacement;
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(replacement).toHaveProperty("stream", false);
    expect(bodies[0]).toHaveProperty("stream", true);
    expect(bodies[0]).not.toHaveProperty("temperature");
  });
});
