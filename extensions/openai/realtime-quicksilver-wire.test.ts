import { describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
} from "./realtime-quicksilver-wire.js";

function createCall(
  fetchImpl: typeof fetch,
  { model = "gpt-live-test-canary", oauth = false } = {},
) {
  return createOpenAIQuicksilverCall(
    {
      auth: oauth
        ? { type: "oauth", token: "oauth-token", accountId: "acct-1" }
        : { type: "api-key", token: "platform-key" },
      requestIds: {
        realtimeSessionId: "test-realtime",
        sessionId: "test-session",
        threadId: "test-thread",
      },
      sdp: "v=offer\r\n",
      session: { model },
      fetchImpl,
    },
    openAIRealtimeHost,
  );
}

function respond(body: string, init: ResponseInit) {
  return vi.fn<typeof fetch>(async () => new Response(body, init));
}

it("bounds shared background UTF-8 without splitting emoji", () => {
  const text = "🦞".repeat(1_000);
  const initialItems = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `${index}:${text}`,
  }));
  const params = {
    model: "gpt-live-test",
    instructions: "Keep it brief.",
    hostControlsInput: true,
  };
  const empty = buildOpenAIQuicksilverSession(params);
  const session = buildOpenAIQuicksilverSession({ ...params, initialItems });
  const background = session.instructions.slice(empty.instructions.length);
  const records = background.match(
    /<shared_session_history>\n(.*)\n<\/shared_session_history>$/s,
  )?.[1];
  expect(JSON.parse(records!)).toEqual(
    initialItems.slice(-2).map((item) => ({
      role: item.role,
      text: Array.from(item.text).slice(0, 800).join(""),
    })),
  );
  expect(Buffer.byteLength(background, "utf8")).toBeLessThanOrEqual(8_000);
});

describe("Realtime call creation", () => {
  it.each([
    [403, "Voice session access denied.", /rejected the session \(403\).*account, model/],
    [400, '{"error":{"code":"model_not_found"}}', /Platform API-key access is unavailable/],
    [400, "session.model not allowed", /model value is not permitted.*Settings > Talk/],
  ] as const)("maps %s: %s", async (status, body, message) => {
    await expect(createCall(respond(body, { status }))).rejects.toThrow(message);
  });

  it("bounds and cancels an oversized streaming GA realtime error response", async () => {
    const chunkCount = 32;
    const streamed = createStreamingResponse({
      status: 429,
      chunkCount,
      chunkSize: 1,
      text: `provider diagnostic: ${"x".repeat(1024)}`,
      headers: { "Content-Type": "text/plain" },
    });
    await expect(
      createCall(vi.fn<typeof fetch>().mockResolvedValue(streamed.response), {
        model: "gpt-realtime-2.1",
      }),
    ).rejects.toMatchObject({
      message: "OpenAI Realtime call creation failed (429)",
    });
    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(chunkCount);
  });

  it.each([
    { location: "http://[invalid", callId: "rtc_malformed_location_fallback" },
    { location: "/v1/live/not-a-call", callId: "rtc_invalid_path_fallback" },
  ])("falls back to openai-session-id for Location $location", async ({ location, callId }) => {
    const fetchImpl = respond("v=answer\r\n", {
      status: 201,
      headers: { Location: location, "openai-session-id": callId },
    });

    await expect(createCall(fetchImpl, { oauth: true })).resolves.toMatchObject({ callId });
  });

  it.each([
    [
      "private detail",
      "provider rejected gpt-live-test-canary sensitive-session",
      422,
      {},
      /^GPT-Live call creation failed \(422\)$/,
    ],
    ["empty SDP", "", 201, { oauth: true }, /GPT-Live.*empty SDP answer/],
    [
      "oversized SDP",
      `v=answer\r\n${"x".repeat(256 * 1024)}`,
      201,
      { model: "gpt-realtime-2.1" },
      /OpenAI Realtime SDP answer: text response exceeds 262144 bytes/,
    ],
  ] as const)("rejects %s", async (_label, body, status, options, message) => {
    await expect(createCall(respond(body, { status }), options)).rejects.toThrow(message);
  });
});
