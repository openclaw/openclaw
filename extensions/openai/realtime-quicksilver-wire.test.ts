import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
} from "./realtime-quicksilver-wire.js";

function createRequestIds(label: string) {
  return {
    realtimeSessionId: `${label}-realtime`,
    sessionId: `${label}-session`,
    threadId: `${label}-thread`,
  };
}

describe("GPT-Live session history", () => {
  it.each([{ name: "UTF-8 without splitting emoji", text: "🦞".repeat(1_000), retained: 2 }])(
    "bounds shared background including $name",
    ({ text, retained }) => {
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
        initialItems.slice(-retained).map((item) => ({
          role: item.role,
          text: Array.from(item.text).slice(0, 800).join(""),
        })),
      );
      expect(records).not.toContain("</shared_session_history>");
      expect(Buffer.byteLength(background, "utf8")).toBeLessThanOrEqual(8_000);
      expect(session).not.toHaveProperty("initial_items");
      expect(buildOpenAIQuicksilverSession({ ...params, initialItems: [] })).toEqual(empty);
    },
  );
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
    const fetchImpl = vi.fn(async () => new Response(body, { status }));
    const promise = createOpenAIQuicksilverCall(
      {
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("error"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      openAIRealtimeHost,
    );
    await expect(promise).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status,
      message,
    });
  });

  it("omits private provider detail from call creation errors", async () => {
    const model = "gpt-live-test-canary";
    const sensitiveDetail = "sensitive-route sensitive-session sensitive-transcript";
    const fetchImpl = vi.fn(
      async () => new Response(`provider rejected ${model} ${sensitiveDetail}`, { status: 422 }),
    );
    const promise = createOpenAIQuicksilverCall(
      {
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("model-redaction"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      openAIRealtimeHost,
    );

    await expect(promise).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status: 422,
      message: "GPT-Live call creation failed (422)",
    });
  });

  it.each([
    {
      name: "GA realtime",
      model: "gpt-realtime-2.1",
      expectedMessage: "OpenAI Realtime call creation failed (429)",
    },
  ])("bounds and cancels an oversized streaming $name error response", async (testCase) => {
    const detailPrefix = "provider diagnostic: ";
    let resolveResponseClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.once("close", () => resolveResponseClosed?.());
      response.writeHead(429, { "Content-Type": "text/plain" });
      response.write(detailPrefix + "x".repeat(32 * 1024));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test HTTP server did not bind a TCP port");
    }

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2_000);
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${address.port}/realtime-call`, {
        ...init,
        signal: controller.signal,
      })) as typeof fetch;

    try {
      const promise = createOpenAIQuicksilverCall(
        {
          auth: { type: "api-key", token: "platform-key" },
          requestIds: createRequestIds(`streaming-error-${testCase.name}`),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: testCase.model }),
          signal: controller.signal,
          fetchImpl,
        },
        openAIRealtimeHost,
      );
      await expect(promise).rejects.toMatchObject({
        name: "OpenAIQuicksilverCallError",
        status: 429,
        message: testCase.expectedMessage,
      });
      await responseClosed;
      expect(controller.signal.aborted).toBe(false);
    } finally {
      clearTimeout(abortTimer);
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    { location: "http://[invalid", callId: "rtc_malformed_location_fallback" },
    { location: "/v1/live/not-a-call", callId: "rtc_invalid_path_fallback" },
  ])("falls back to openai-session-id for Location $location", async ({ location, callId }) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: {
            Location: location,
            "openai-session-id": callId,
          },
        }),
    );

    await expect(
      createOpenAIQuicksilverCall(
        {
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("header-fallback"),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
    ).resolves.toMatchObject({ callId });
  });

  it("rejects an empty SDP answer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", {
          status: 201,
          headers: { Location: "/v1/live/rtc_empty_answer" },
        }),
    );
    await expect(
      createOpenAIQuicksilverCall(
        {
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("empty-answer"),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
    ).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status: 201,
      message: "GPT-Live call creation returned an empty SDP answer",
    });
  });

  it.each([
    {
      label: "OpenAI Realtime",
      auth: { type: "api-key" as const, token: "platform-key" },
      model: "gpt-realtime-2.1",
    },
  ])("rejects an oversized streaming $label SDP answer", async (testCase) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(`v=answer\r\n${"x".repeat(256 * 1024)}`, {
          status: 201,
        }),
    );

    await expect(
      createOpenAIQuicksilverCall(
        {
          auth: testCase.auth,
          requestIds: createRequestIds(`oversized-answer-${testCase.label}`),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: testCase.model }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
    ).rejects.toThrow(`${testCase.label} SDP answer: text response exceeds 262144 bytes`);
  });
});
