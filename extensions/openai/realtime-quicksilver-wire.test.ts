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
      session: buildOpenAIQuicksilverSession({ model }),
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
  expect(records).toBeDefined();
  expect(JSON.parse(records!)).toEqual(
    initialItems.slice(-2).map((item) => ({
      role: item.role,
      text: Array.from(item.text).slice(0, 800).join(""),
    })),
  );
  expect(records).not.toContain("</shared_session_history>");
  expect(Buffer.byteLength(background, "utf8")).toBeLessThanOrEqual(8_000);
  expect(session).not.toHaveProperty("initial_items");
  expect(buildOpenAIQuicksilverSession({ ...params, initialItems: [] })).toEqual(empty);
});

describe("Realtime call creation", () => {
  it.each([
    {
      name: "overloaded rejection",
      status: 403,
      body: "Voice session access denied.",
      message:
        "GPT-Live rejected the session (403). Verify the selected OpenAI account, model, and GPT-Live voice; this response alone does not identify which was denied.",
    },
    {
      name: "Platform model access denial",
      status: 400,
      body: '{"error":{"code":"model_not_found","message":"The model does not exist or you do not have access"}}',
      message:
        "OpenAI Platform API-key access is unavailable for the selected GPT-Live model. Verify the selected model and Platform account access.",
    },
    {
      name: "unsupported route model",
      status: 400,
      body: "Field `session.model` is not allowed for this Codex realtime session",
      message:
        "The GPT-Live model value is not permitted. Choose a supported GPT-Live model in Settings > Talk.",
    },
  ])("maps $name", async ({ status, body, message }) => {
    const promise = createCall(respond(body, { status }));
    await expect(promise).rejects.toMatchObject({ message });
  });

  it("omits private provider detail from call creation errors", async () => {
    const model = "gpt-live-test-canary";
    const sensitiveDetail = "sensitive-route sensitive-session sensitive-transcript";
    const fetchImpl = respond(`provider rejected ${model} ${sensitiveDetail}`, { status: 422 });
    const promise = createCall(fetchImpl, { model });

    await expect(promise).rejects.toMatchObject({
      message: "GPT-Live call creation failed (422)",
    });
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
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamed.response);

    await expect(createCall(fetchImpl, { model: "gpt-realtime-2.1" })).rejects.toMatchObject({
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
      headers: {
        Location: location,
        "openai-session-id": callId,
      },
    });

    await expect(createCall(fetchImpl, { oauth: true })).resolves.toMatchObject({ callId });
  });

  it("rejects an empty SDP answer", async () => {
    const fetchImpl = respond("", {
      status: 201,
      headers: { Location: "/v1/live/rtc_empty_answer" },
    });
    await expect(createCall(fetchImpl, { oauth: true })).rejects.toMatchObject({
      message: "GPT-Live call creation returned an empty SDP answer",
    });
  });

  it("rejects an oversized streaming OpenAI Realtime SDP answer", async () => {
    const fetchImpl = respond(`v=answer\r\n${"x".repeat(256 * 1024)}`, { status: 201 });

    await expect(createCall(fetchImpl, { model: "gpt-realtime-2.1" })).rejects.toThrow(
      "OpenAI Realtime SDP answer: text response exceeds 262144 bytes",
    );
  });
});
