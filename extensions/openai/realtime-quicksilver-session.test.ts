import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import {
  FakeSocket,
  createRequest,
  createPreflightRequest,
  createResponseHarness,
  emitSideband,
  createBroker,
} from "./realtime-quicksilver.test-helpers.js";

const brokers: ReturnType<typeof createBroker>["realtime"][] = [];
function makeBroker(params?: Parameters<typeof createBroker>[0]) {
  const harness = createBroker(params);
  brokers.push(harness.realtime);
  return harness;
}
afterEach(async () => {
  try {
    for (const broker of brokers.splice(0)) {
      await broker.cleanup();
    }
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

function requestTarget(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

async function post(
  realtime: ReturnType<typeof createBroker>["realtime"],
  params: Parameters<typeof createRequest>[0],
) {
  const response = createResponseHarness();
  await realtime.handler(createRequest(params), response.res);
  return response;
}

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  } satisfies RealtimeVoiceBridge;
}

async function reserveGaSession(
  realtime: ReturnType<typeof createBroker>["realtime"],
  createBridge: (params: {
    apiKey: string;
    callId: string;
    onTerminal: () => void;
  }) => RealtimeVoiceBridge,
  gatewayControl: RealtimeVoiceGatewayControl = { bindBridge: vi.fn() },
) {
  const reservation = await realtime.broker.createBrowserSession(
    {
      providerConfig: {},
      model: "gpt-realtime-2.1",
      gatewayControl,
      gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
      clientControl: { owner: "gateway" },
      gaSideband: { createBridge },
    },
    { type: "api-key", token: "platform-key" },
  );
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

function createGaFetch(callId: string) {
  return vi.fn<typeof fetch>(async (url) =>
    requestTarget(url).endsWith("/hangup")
      ? new Response(null, { status: 204 })
      : new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: `/v1/realtime/calls/${callId}` },
        }),
  );
}

async function reserveLiveSession(
  realtime: ReturnType<typeof createBroker>["realtime"],
  overrides: Pick<
    RealtimeVoiceBrowserSessionCreateRequest,
    "model" | "runAgentConsult" | "gatewayControl" | "voice"
  > = {},
) {
  const reservation = await realtime.broker.createBrowserSession(
    {
      providerConfig: {},
      model: "gpt-live-test-canary",
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      ...overrides,
    },
    { type: "api-key", token: "platform-key" },
  );
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

describe("GPT-Live offer broker", () => {
  it("waits for the GA sideband before returning an audio-only SDP answer and hangs up once", async () => {
    const { promise: sidebandReady, resolve: releaseSideband } = Promise.withResolvers<void>();
    const bridge = makeBridge({ connect: vi.fn(async () => await sidebandReady) });
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const target = requestTarget(url);
      if (target.endsWith("/hangup")) {
        return new Response(null, { status: 204 });
      }
      expect(target).toBe("https://api.openai.com/v1/realtime/calls");
      const form = init?.body;
      expect(form).toBeTypeOf("string");
      expect(form).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
      expect(form).not.toContain("m=application");
      return new Response("v=ga-answer\r\n", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/rtc_gateway" },
      });
    });
    const { realtime, logger } = makeBroker({ fetchImpl: fetchMock });
    let terminateSideband: (() => void) | undefined;
    const createBridge = vi.fn((params: { onTerminal: () => void }) => {
      terminateSideband = params.onTerminal;
      return bridge;
    });
    try {
      const reservation = await reserveGaSession(realtime, createBridge);
      expect(reservation).not.toHaveProperty("model");
      expect(reservation).not.toHaveProperty("voice");
      expect(reservation.offerResponseMaxBytes).toBe(256 * 1024);
      const response = createResponseHarness();
      const handling = realtime.handler(
        createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
        response.res,
      );
      await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalledOnce());
      expect(response.end).not.toHaveBeenCalled();
      expect(createBridge).toHaveBeenCalledWith({
        apiKey: "platform-key",
        callId: "rtc_gateway",
        onTerminal: expect.any(Function),
      });
      releaseSideband();
      await expect(handling).resolves.toBe(true);
      expect(response.res.statusCode).toBe(201);
      expect(response.readBody()).toBe("v=ga-answer\r\n");
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(
          /^OpenAI Realtime sideband offer ready \{"callCreateMs":\d+,"sidebandReadyMs":\d+,"totalOfferMs":\d+\}$/,
        ),
      );

      const hangups = () =>
        fetchMock.mock.calls.filter(([url]) => requestTarget(url).endsWith("/rtc_gateway/hangup"));
      terminateSideband?.();
      await vi.waitFor(() => expect(hangups()).toHaveLength(1));
      await realtime.broker.cancelBrowserSession(reservation);
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(hangups()).toHaveLength(1);
    } finally {
      releaseSideband();
    }
  });

  it("hangs up a GA call when sideband startup fails", async () => {
    const privateValue = "sensitive-route";
    const onError = vi.fn();
    const bridge = makeBridge({
      connect: vi.fn(async () => {
        throw new Error(privateValue);
      }),
      isConnected: vi.fn(() => false),
    });
    const fetchMock = createGaFetch("rtc_error");
    const { realtime } = makeBroker({ fetchImpl: fetchMock });
    const reservation = await reserveGaSession(realtime, () => bridge, {
      bindBridge: vi.fn(),
      onError,
    });
    const response = await post(realtime, {
      token: reservation.clientSecret,
      body: AUDIO_ONLY_SDP,
    });
    expect(response.res.statusCode).toBe(502);
    expect(response.readBody()).toContain("OpenAI GPT-Live transport failed");
    expect(response.readBody()).not.toContain(privateValue);
    expect(onError).toHaveBeenCalledOnce();
    const callbackError = onError.mock.calls[0]?.[0] as Error | undefined;
    expect(callbackError).toBeInstanceOf(Error);
    expect(callbackError).toMatchObject({
      name: "Error",
      message: "OpenAI GPT-Live transport failed",
    });
    expect(callbackError?.cause).toBeUndefined();
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.filter(([url]) => requestTarget(url).endsWith("/rtc_error/hangup")),
    ).toHaveLength(1);
  });

  it("hangs up when the GA answer is not delivered to the client", async () => {
    const bridge = makeBridge();
    const fetchMock = createGaFetch("rtc_delivery");
    const { realtime } = makeBroker({ fetchImpl: fetchMock });
    const reservation = await reserveGaSession(realtime, () => bridge);
    const response = createResponseHarness();
    response.end.mockImplementationOnce(() => {
      queueMicrotask(() => response.res.emit("close"));
    });
    await realtime.handler(
      createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
      response.res,
    );

    expect(bridge.close).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.filter(([url]) => requestTarget(url).endsWith("/rtc_delivery/hangup")),
    ).toHaveLength(1);
  });

  it.each([
    [
      "active data channel",
      `${AUDIO_ONLY_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`,
      "application media",
    ],
    ["no active audio", "v=0\r\nm=audio 0 UDP/TLS/RTP/SAVPF 111\r\n", "active audio"],
    ["oversized line", `${AUDIO_ONLY_SDP}a=${"x".repeat(4_097)}\r\n`, "line is too large"],
  ])(
    "rejects a bounded GA sideband SDP with %s before provider creation",
    async (_name, body, message) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const { realtime } = makeBroker({ fetchImpl });
      const reservation = await reserveGaSession(realtime, vi.fn());
      const response = await post(realtime, { token: reservation.clientSecret, body });
      expect(response.res.statusCode).toBe(400);
      expect(response.readBody()).toContain(message);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("survives a connecting socket that errors during retry teardown", async () => {
    // ws emits an unhandled `error` asynchronously when a CONNECTING socket closes.
    class ErrorOnCloseSocket extends FakeSocket {
      constructor() {
        super("manual");
      }
      override close(code?: number, reason?: string): void {
        queueMicrotask(() => this.emit("error", new Error("socket hang up")));
        super.close(code, reason);
      }
    }
    const { realtime, sockets } = makeBroker({
      socketFactory: (attempt) => (attempt < 1 ? new ErrorOnCloseSocket() : new FakeSocket("open")),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reservation = await reserveLiveSession(realtime);
    const response = createResponseHarness();
    const handling = realtime.handler(
      createRequest({ token: reservation.clientSecret }),
      response.res,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.readyState).toBe(0);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sockets[0]?.closed).toBe(false);
    expect(response.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await handling;
    await vi.advanceTimersByTimeAsync(0);

    expect(response.res.statusCode).toBe(200);
    expect(response.readBody()).toBe("v=answer\r\n");
    expect(sockets[0]?.listenerCount("error")).toBeGreaterThan(0);
  });

  it("retries transient sideband startup failures", async () => {
    const { realtime, sockets } = makeBroker({
      socketFactory: (attempt) => new FakeSocket(attempt < 2 ? "error" : "open"),
    });
    const reservation = await reserveLiveSession(realtime);
    const response = await post(realtime, { token: reservation.clientSecret });

    expect(response.res.statusCode).toBe(200);
    expect(sockets).toHaveLength(3);
    expect(sockets).toMatchObject([{ closeCode: 1000 }, { closeCode: 1000 }, { readyState: 1 }]);
  });

  it("buffers sideband messages that arrive with the open handshake", async () => {
    const runAgentConsult = vi.fn(async () => ({ text: "Done" }));
    const { realtime, sockets } = makeBroker({
      runAgentConsult,
      socketFactory: () => {
        const socket = new FakeSocket("manual");
        queueMicrotask(() => {
          emitSideband(socket, {
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: "early-delegation",
              content: [{ type: "input_text", text: "early task" }],
            },
          });
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    });
    const reservation = await reserveLiveSession(realtime, { runAgentConsult });
    await post(realtime, { token: reservation.clientSecret });

    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    expect(sockets).toHaveLength(1);
  });

  it.each(["error", "close"] as const)(
    "fails safely when the sideband emits %s immediately after opening",
    async (terminalEvent) => {
      const onError = vi.fn();
      const onClose = vi.fn();
      const { realtime, sockets, logger } = makeBroker({
        socketFactory: () => {
          const socket = new FakeSocket("manual");
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.emit("open");
            if (terminalEvent === "error") {
              socket.emit("error", new Error("sensitive-route sensitive-session"));
            } else {
              socket.readyState = 3;
              socket.emit("close");
            }
          });
          return socket;
        },
      });
      const reservation = await reserveLiveSession(realtime, {
        gatewayControl: { bindBridge: vi.fn(), onError, onClose },
      });
      const response = await post(realtime, { token: reservation.clientSecret });

      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toContain("OpenAI GPT-Live transport failed");
      expect(sockets).toHaveLength(1);
      expect(onError).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      if (terminalEvent === "error") {
        expect(logger.warn).toHaveBeenCalledWith("OpenAI GPT-Live transport failed");
      }
      const callbackMessage = (onError.mock.calls[0]?.[0] as Error | undefined)?.message;
      expect(callbackMessage).toBe("OpenAI GPT-Live transport failed");
      for (const privateValue of ["sensitive-route", "sensitive-session"]) {
        expect(response.readBody()).not.toContain(privateValue);
        expect(logger.warn.mock.calls.flat().join("\n")).not.toContain(privateValue);
        expect(callbackMessage).not.toContain(privateValue);
      }
    },
  );

  it("keeps nonfatal error frames alive but closes on fatal auth errors", async () => {
    const { realtime, sockets, logger } = makeBroker();
    const reservation = await reserveLiveSession(realtime);
    await post(realtime, { token: reservation.clientSecret });
    const socket = sockets[0];
    if (!socket) {
      throw new Error("Expected sideband socket");
    }

    emitSideband(socket, { type: "error", message: "recoverable turn failure" });
    expect(socket.closed).toBe(false);
    emitSideband(socket, { type: "error", error: { code: "invalid_token" } });
    expect(socket).toMatchObject({ closed: true, closeCode: 1000 });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { origin: "https://control.example", host: undefined, allowed: true },
    { origin: "http://192.168.1.24:18789", host: "192.168.1.24:18789", allowed: true },
    { origin: "https://untrusted.example", host: "192.168.1.24:18789", allowed: false },
  ])("enforces CORS for $origin on preflight and POST", async ({ origin, host, allowed }) => {
    const { realtime } = makeBroker();
    const preflight = createResponseHarness();
    await realtime.handler(createPreflightRequest(origin, host), preflight.res);
    expect(preflight.res.statusCode).toBe(allowed ? 204 : 403);
    const response = await post(realtime, { token: "invalid", origin, host });
    expect(response.res.statusCode).toBe(allowed ? 401 : 403);
    if (allowed) {
      expect(preflight.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", origin);
      expect(preflight.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Private-Network",
        "true",
      );
      expect(response.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", origin);
    }
  });

  it("uses a relative single-use offer route and normalizes voice", async () => {
    const { realtime } = makeBroker();
    const reservation = await reserveLiveSession(realtime, { voice: "invalid" });
    expect(reservation).toMatchObject({
      offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
      model: "gpt-live-test-canary",
      voice: "marin",
      expiresAt: expect.any(Number),
    });
    const first = await post(realtime, {
      token: reservation.clientSecret,
      origin: "https://control.example",
    });
    expect(first.res.statusCode).toBe(200);
    expect(first.readBody()).toBe("v=answer\r\n");
    const replay = await post(realtime, { token: reservation.clientSecret });
    expect(replay.res.statusCode).toBe(401);
  });

  it("rejects expired tokens, unsupported methods, and content types", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { realtime } = makeBroker();
    const method = await post(realtime, { method: "GET" });
    expect(method.res.statusCode).toBe(405);

    const contentType = await post(realtime, { contentType: "application/json" });
    expect(contentType.res.statusCode).toBe(415);
    const contentTypePrefix = await post(realtime, { contentType: "application/sdp+json" });
    expect(contentTypePrefix.res.statusCode).toBe(415);

    const reservation = await reserveLiveSession(realtime, { model: "gpt-live-1" });
    now.mockReturnValue(61_001);
    const expired = await post(realtime, { token: reservation.clientSecret });
    expect(expired.res.statusCode).toBe(401);
  });

  it("expires an unused Gateway-control offer despite a throwing callback", async () => {
    vi.useFakeTimers();
    const { realtime } = makeBroker();
    const onClose = vi.fn(() => {
      throw new Error("close callback failed");
    });
    const reservation = await reserveGaSession(realtime, vi.fn(), {
      bindBridge: vi.fn(),
      onClose,
    });

    const expiryError = await vi.advanceTimersByTimeAsync(60_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect.soft(expiryError).toBeUndefined();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    const expired = await post(realtime, { token: reservation.clientSecret });
    expect(expired.res.statusCode).toBe(401);
  });

  it("releases a reservation after an empty SDP offer", async () => {
    const { realtime } = makeBroker();
    const reservation = await reserveLiveSession(realtime, { model: "gpt-live-1" });
    const response = await post(realtime, { token: reservation.clientSecret, body: "   " });
    expect(response.res.statusCode).toBe(400);

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () => reserveLiveSession(realtime, { model: "gpt-live-1" })),
      ),
    ).resolves.toHaveLength(8);
  });

  it("aborts a redeemed offer when its browser session is canceled", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal ?? undefined;
          const rejectAbort = () => {
            const reason = upstreamSignal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          };
          upstreamSignal?.addEventListener("abort", rejectAbort, { once: true });
          if (upstreamSignal?.aborted) {
            rejectAbort();
          }
        }),
    );
    const { realtime, sockets } = makeBroker({ fetchImpl });
    const reservation = await reserveLiveSession(realtime, { model: "gpt-live-1" });
    const response = createResponseHarness();
    const handling = realtime.handler(
      createRequest({ token: reservation.clientSecret }),
      response.res,
    );
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());

    await realtime.broker.cancelBrowserSession(reservation);

    await expect(handling).resolves.toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.res.statusCode).toBe(502);
    expect(response.readBody()).toContain("OpenAI GPT-Live transport failed");
    expect(response.end).toHaveBeenCalledOnce();
    expect(sockets).toEqual([]);
  });
});
