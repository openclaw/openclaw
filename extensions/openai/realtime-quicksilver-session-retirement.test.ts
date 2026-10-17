import { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  acquireOpenAIQuicksilverBrowserSessionBroker as acquireBroker,
  releaseOpenAIQuicksilverBrowserSessionBroker as releaseBroker,
} from "./realtime-quicksilver-session-owner.js";
import {
  createBroker,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const OPAQUE_REALTIME_MODEL = "gpt-live-test-canary";

function requestTarget(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}

function callResponse(answer = "v=answer\r\n", callId = "rtc_retirement") {
  return new Response(answer, {
    status: 201,
    headers: { Location: `/v1/realtime/calls/${callId}` },
  });
}

function retirementFetch(
  hangup: () => Response | Promise<Response>,
  create: () => Response | Promise<Response> = callResponse,
) {
  return vi.fn<typeof fetch>(async (url) =>
    requestTarget(url).endsWith("/hangup") ? hangup() : create(),
  );
}

function offerRequest(token: string) {
  return createRequest({ token, body: AUDIO_ONLY_SDP });
}

function retirementBridge() {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    isConnected: vi.fn(() => true),
  } satisfies RealtimeVoiceBridge;
}

async function reserveRetirementSession(
  realtime: ReturnType<typeof createBroker>["realtime"],
  createBridge: (params: { onTerminal: () => void }) => RealtimeVoiceBridge,
  ownerConnId?: string,
  gatewayControl: RealtimeVoiceGatewayControl = { bindBridge: vi.fn() },
) {
  const reservation = await realtime.broker.createBrowserSession(
    {
      providerConfig: {},
      model: "gpt-realtime-2.1",
      gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
      gaSideband: { createBridge },
      clientControl: { owner: "gateway" },
      gatewayControl,
      ...(ownerConnId ? { ownerConnId } : {}),
    },
    { type: "api-key", token: "platform-key" },
  );
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

describe("GA Realtime call retirement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes broker config and logger without replacing its native operations or reservations", async () => {
    const originalHeaders = vi.fn(openAIRealtimeHost.resolveProviderRequestHeaders);
    const replacementHeaders = vi.fn(openAIRealtimeHost.resolveProviderRequestHeaders);
    const originalConfig = vi.fn(() => undefined);
    const nextConfig = vi.fn(() => ({
      gateway: { controlUi: { allowedOrigins: ["https://updated.example"] } },
    }));
    const originalLogger = { debug: vi.fn(), warn: vi.fn() };
    const nextLogger = { debug: vi.fn(), warn: vi.fn() };
    vi.stubGlobal(
      "fetch",
      retirementFetch(() => new Response(null, { status: 204 })),
    );
    const first = acquireBroker(
      { getConfig: originalConfig, logger: originalLogger },
      { ...openAIRealtimeHost, resolveProviderRequestHeaders: originalHeaders },
    );
    try {
      const reservation = await reserveRetirementSession(first, retirementBridge);
      const retained = acquireBroker(
        { getConfig: nextConfig, logger: nextLogger },
        { ...openAIRealtimeHost, resolveProviderRequestHeaders: replacementHeaders },
      );
      expect(retained).toBe(first);
      const response = createResponseHarness();
      await retained.handler(
        createRequest({
          token: reservation.clientSecret,
          body: AUDIO_ONLY_SDP,
          origin: "https://updated.example",
        }),
        response.res,
      );
      expect(response.res.statusCode).toBe(201);
      expect(originalConfig).not.toHaveBeenCalled();
      expect(nextConfig).toHaveBeenCalledOnce();
      expect(originalLogger.debug).not.toHaveBeenCalled();
      expect(nextLogger.debug).toHaveBeenCalledOnce();
      expect(originalHeaders).toHaveBeenCalledOnce();
      expect(replacementHeaders).not.toHaveBeenCalled();
      await releaseBroker(retained);
      expect(originalHeaders).toHaveBeenCalledTimes(2);
      expect(replacementHeaders).not.toHaveBeenCalled();
    } finally {
      await releaseBroker(first);
    }
  });

  it.each([
    "throwing error callback",
    "terminal during construction",
    "empty answer",
    "shutdown during creation",
    "cancel during creation",
  ])("retries GA retirement after %s without a client retry", async (failure) => {
    vi.useFakeTimers();
    const bridge = retirementBridge();
    let creations = 0;
    let hangups = 0;
    let failHangup = true;
    const creation = createDeferred<void>();
    const firstHangup = createDeferred<void>();
    let cancelSettled = false;
    const fetchImpl = retirementFetch(
      async () => {
        hangups += 1;
        if (failure === "cancel during creation" && hangups === 1) {
          await firstHangup.promise;
        }
        return new Response(null, { status: failHangup && hangups < 3 ? 503 : 204 });
      },
      async () => {
        creations += 1;
        await creation.promise;
        return callResponse(failure === "empty answer" ? "" : "v=answer\r\n");
      },
    );
    const { realtime } = createBroker({ fetchImpl });
    try {
      const onClose = vi.fn();
      const reservation = await reserveRetirementSession(
        realtime,
        ({ onTerminal }) => {
          if (failure === "terminal during construction") {
            onTerminal();
          }
          if (failure === "throwing error callback") {
            vi.mocked(bridge.connect).mockRejectedValue(new Error("connect failed"));
          }
          return bridge;
        },
        undefined,
        failure === "throwing error callback"
          ? {
              bindBridge: vi.fn(),
              onError: () => {
                throw new Error("error callback failed");
              },
              onClose,
            }
          : undefined,
      );
      const response = createResponseHarness();
      const handling = realtime.handler(offerRequest(reservation.clientSecret), response.res);
      await vi.waitFor(() => expect(creations).toBe(1));
      const stopping =
        failure === "shutdown during creation"
          ? realtime.cleanup().catch((error: unknown) => error)
          : failure === "cancel during creation"
            ? Promise.resolve(realtime.broker.cancelBrowserSession(reservation)).then(
                () => {
                  cancelSettled = true;
                  return undefined;
                },
                (error: unknown) => {
                  cancelSettled = true;
                  return error;
                },
              )
            : undefined;
      creation.resolve();
      if (failure === "cancel during creation") {
        await vi.waitFor(() => expect(hangups).toBe(1));
        expect.soft(cancelSettled).toBe(false);
        firstHangup.resolve();
      }
      const handlingError = await handling.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect.soft(handlingError).toBeUndefined();
      if (failure === "throwing error callback") {
        expect.soft(onClose).toHaveBeenCalledOnce();
      }
      expect(hangups).toBe(1);
      if (stopping) {
        const stopError = await stopping;
        if (failure === "cancel during creation") {
          expect(response.res.statusCode).toBe(502);
          expect(stopError).toMatchObject({ message: "OpenAI Realtime call hangup failed (503)" });
        } else {
          expect(stopError).toBeInstanceOf(Error);
        }
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(hangups).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(hangups).toBe(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(hangups).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(hangups).toBe(3);
      expect(creations).toBe(1);
      expect(bridge.close).toHaveBeenCalledTimes(
        ["shutdown during creation", "cancel during creation", "empty answer"].includes(failure)
          ? 0
          : 1,
      );
      const replay = createResponseHarness();
      await realtime.handler(offerRequest(reservation.clientSecret), replay.res);
      expect(replay.res.statusCode).toBe(401);
      await realtime.cleanup();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(hangups).toBe(3);
    } finally {
      failHangup = false;
      creation.resolve();
      firstHangup.resolve();
      await realtime.cleanup();
    }
  });

  it("joins the first failed retirement when delayed answer delivery finishes", async () => {
    vi.useFakeTimers();
    const bridge = retirementBridge();
    let hangups = 0;
    let failHangup = true;
    const delivering = createDeferred<void>();
    const fetchImpl = retirementFetch(() => {
      hangups += 1;
      return new Response(null, { status: failHangup ? 503 : 204 });
    });
    const { realtime, logger } = createBroker({ fetchImpl });
    const request = createRequest({ body: AUDIO_ONLY_SDP });
    const response = new ServerResponse(request);
    const end = vi.spyOn(response, "end").mockImplementationOnce(() => {
      response.writeHead(response.statusCode);
      delivering.resolve();
      return response;
    });
    let handling: Promise<boolean> | undefined;
    try {
      const reservation = await reserveRetirementSession(realtime, () => bridge);
      request.headers.authorization = `Bearer ${reservation.clientSecret}`;
      handling = realtime.handler(request, response);
      await delivering.promise;
      expect(response.headersSent).toBe(true);
      await expect(realtime.broker.cancelBrowserSession(reservation)).rejects.toThrow(
        "OpenAI Realtime call hangup failed (503)",
      );
      expect(hangups).toBe(1);
      response.emit("finish");
      await expect(handling).resolves.toBe(true);
      expect(end).toHaveBeenCalledOnce();
      expect.soft(hangups).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect.soft(hangups).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect.soft(hangups).toBe(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect.soft(hangups).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect.soft(hangups).toBe(3);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect.soft(hangups).toBe(3);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("INCOMPLETE"));
      expect(bridge.close).toHaveBeenCalledOnce();
    } finally {
      failHangup = false;
      response.emit("finish");
      await handling?.catch(() => undefined);
      await realtime.cleanup();
    }
  });

  it("awaits rejected sideband retirement before hangup and reservation release", async () => {
    const retired = createDeferred<void>();
    const bridge = retirementBridge();
    vi.mocked(bridge.close).mockReturnValue(retired.promise);
    const hangup = vi.fn(() => new Response(null, { status: 204 }));
    const { realtime } = createBroker({ fetchImpl: retirementFetch(hangup) });
    try {
      const reservation = await reserveRetirementSession(realtime, () => bridge);
      await realtime.handler(offerRequest(reservation.clientSecret), createResponseHarness().res);
      const closing = realtime.broker.cancelBrowserSession(reservation);
      const concurrent = realtime.cleanup();
      expect(realtime.getSessionCounts()).toMatchObject({ active: 0, reservations: 1 });
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(hangup).not.toHaveBeenCalled();
      retired.reject(new Error("sideband disposal failed"));
      await Promise.all([closing, concurrent]);
      expect(hangup).toHaveBeenCalledOnce();
      expect(realtime.getSessionCounts()).toMatchObject({ active: 0, reservations: 0 });
    } finally {
      retired.resolve();
      await realtime.cleanup();
    }
  });

  it("coalesces reentrant retirement and settles HTTP 404 once", async () => {
    vi.useFakeTimers();
    const bridge = retirementBridge();
    const hungUp = createDeferred<void>();
    let hangups = 0;
    const fetchImpl = retirementFetch(async () => {
      hangups += 1;
      await hungUp.promise;
      return new Response(null, { status: 404 });
    });
    const { realtime } = createBroker({ fetchImpl });
    let reentered: Promise<void> | undefined;
    try {
      const reservation = await reserveRetirementSession(realtime, ({ onTerminal }) => {
        vi.mocked(bridge.close).mockImplementation(() => {
          onTerminal();
          reentered = Promise.resolve(realtime.broker.cancelBrowserSession(reservation));
        });
        return bridge;
      });
      await realtime.handler(offerRequest(reservation.clientSecret), createResponseHarness().res);
      const first = realtime.broker.cancelBrowserSession(reservation);
      const concurrent = realtime.cleanup();
      expect(hangups).toBe(1);
      expect(bridge.close).toHaveBeenCalledOnce();
      hungUp.resolve();
      await Promise.all([first, concurrent, reentered]);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await realtime.cleanup();
      expect(hangups).toBe(1);
    } finally {
      hungUp.resolve();
      await realtime.cleanup();
    }
  });

  it("retains exhausted old broker calls and per-client native capacity across replacement", async () => {
    const count = 2;
    const ownerConnId = "conn-retiring";
    vi.useFakeTimers();
    let failHangup = true;
    let hangups = 0;
    let callId = 0;
    vi.stubGlobal(
      "fetch",
      retirementFetch(
        () => {
          hangups += 1;
          return new Response(null, { status: failHangup ? 503 : 204 });
        },
        () => callResponse("v=answer\r\n", `rtc_retirement_${++callId}`),
      ),
    );
    const params = { getConfig: () => undefined, logger: { debug: vi.fn(), warn: vi.fn() } };
    const old = acquireBroker(params, openAIRealtimeHost);
    let replacement: typeof old | undefined;
    const reserveNext = (current: typeof old, clientOwner = ownerConnId) =>
      current.broker.createBrowserSession(
        {
          providerConfig: {},
          model: OPAQUE_REALTIME_MODEL,
          ownerConnId: clientOwner,
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
          clientControl: { owner: "gateway" },
          gatewayControl: { bindBridge: vi.fn(), bindControl: vi.fn() },
        },
        { type: "api-key", token: "platform-key" },
      );
    try {
      for (let index = 0; index < count; index += 1) {
        const reservation = await reserveRetirementSession(old, retirementBridge, ownerConnId);
        await old.handler(offerRequest(reservation.clientSecret), createResponseHarness().res);
      }
      await expect(releaseBroker(old)).rejects.toThrow();
      replacement = acquireBroker(params, openAIRealtimeHost);
      expect(replacement).not.toBe(old);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(hangups).toBe(count * 3);
      expect(params.logger.warn).toHaveBeenCalledWith(expect.stringContaining("INCOMPLETE"));
      await expect(reserveNext(replacement)).rejects.toThrow("Too many concurrent");
      await expect(reserveNext(replacement, "conn-other")).resolves.toMatchObject({
        transport: "webrtc",
      });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(hangups).toBe(count * 3);
      const disabledReplacement = replacement;
      await expect(releaseBroker(disabledReplacement)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(hangups).toBe(count * 6);
      replacement = acquireBroker(params, openAIRealtimeHost);
      expect(replacement).not.toBe(disabledReplacement);
      failHangup = false;
      await releaseBroker(disabledReplacement);
      expect(hangups).toBe(count * 7);
      expect(acquireBroker(params, openAIRealtimeHost)).toBe(replacement);
      await expect(reserveNext(replacement)).resolves.toMatchObject({ transport: "webrtc" });
      await releaseBroker(old);
      expect(acquireBroker(params, openAIRealtimeHost)).toBe(replacement);
    } finally {
      failHangup = false;
      await releaseBroker(old);
      if (replacement) {
        await releaseBroker(replacement);
      }
    }
  });
});
