import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceGatewayControl } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  createBroker,
  createRequest,
  createResponseHarness,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

const LIVE_URL = "https://api.openai.com/v1/live/sessions";
const SESSION_ID = "live_opaque/id?part=one";
const HANGUP_URL = `${LIVE_URL}/live_opaque%2Fid%3Fpart%3Done/hangup`;
const SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function liveResponse(sdp = SDP): Response {
  return Response.json(
    { session: { id: SESSION_ID }, transport: { type: "webrtc", sdp } },
    { status: 201 },
  );
}

async function reserveSession(
  fixture: ReturnType<typeof createBroker>,
  gatewayControl?: Pick<RealtimeVoiceGatewayControl, "onTranscript" | "onClose" | "onError">,
) {
  const reservation = await fixture.realtime.broker.createBrowserSession(
    {
      providerConfig: {},
      model: "gpt-live-1",
      instructions: "Answer briefly.",
      initialItems: [{ role: "user", text: "The room is the kitchen." }],
      runAgentConsult: fixture.runAgentConsult,
      ...(gatewayControl ? { gatewayControl: { bindBridge: vi.fn(), ...gatewayControl } } : {}),
    },
    { type: "api-key", token: "platform-key" },
  );
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

describe("public GPT-Live WebRTC broker", () => {
  it.each([
    { reason: "expired", outcome: "completed" },
    { reason: "content", outcome: "error" },
    { reason: "connection_lost", outcome: "error" },
  ])(
    "reports $reason as $outcome without a redundant provider hangup",
    async ({ reason, outcome }) => {
      const fetchImpl = vi.fn<typeof fetch>(async (url) =>
        url === LIVE_URL ? liveResponse() : new Response(null, { status: 503 }),
      );
      const fixture = createBroker({ fetchImpl });
      const onClose = vi.fn();
      const onError = vi.fn();
      try {
        const reservation = await reserveSession(fixture, { onClose, onError });
        const response = createResponseHarness();
        await fixture.realtime.handler(
          createRequest({ token: reservation.clientSecret, body: SDP }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        emitSideband(fixture.sockets[0]!, {
          type: "session.closed",
          reason,
        });
        await fixture.realtime.cleanup();
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fixture.sockets[0]?.closed).toBe(true);
        expect(onClose).toHaveBeenCalledExactlyOnceWith(outcome);
        expect(onError).toHaveBeenCalledTimes(outcome === "error" ? 1 : 0);
        expect(fixture.realtime.getSessionCounts()).toEqual({
          pending: 0,
          inFlight: 0,
          active: 0,
          reservations: 0,
        });
      } finally {
        fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
        await fixture.realtime.cleanup();
      }
    },
  );

  it("accepts an audio and application offer, delegates, and drains final text before closing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      url === HANGUP_URL ? new Response(null, { status: 204 }) : liveResponse(),
    );
    const fixture = createBroker({ fetchImpl });
    const { realtime, sockets, socketRequests, runAgentConsult } = fixture;
    const onTranscript = vi.fn();
    const onClose = vi.fn();
    let reentrantClose: Promise<void> | undefined;
    const offeredSdp = `${SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
    try {
      const reservation = await reserveSession(fixture, { onTranscript, onClose });
      onClose.mockImplementation(() => {
        reentrantClose = Promise.resolve(realtime.broker.cancelBrowserSession(reservation));
      });
      expect(reservation.voice).toBe("marin");
      expect(JSON.stringify(reservation)).not.toContain("platform-key");
      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: offeredSdp }),
        response.res,
      );

      expect(response.res.statusCode).toBe(200);
      expect(response.readBody()).toBe(SDP);
      expect(response.setHeader).toHaveBeenCalledWith("content-type", "application/sdp");
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(LIVE_URL);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer platform-key");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("openai-alpha")).toBe(false);
      if (typeof init?.body !== "string") {
        throw new Error("Expected the public session JSON body");
      }
      expect(JSON.parse(init.body)).toEqual({
        session: {
          model: "gpt-live-1",
          instructions: "Answer briefly.",
          audio: { output: { voice: "marin" } },
          delegation: { type: "client" },
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "The room is the kitchen." }],
            },
          ],
        },
        transport: { type: "webrtc", sdp: offeredSdp },
      });
      expect(socketRequests[0]?.url).toBe(
        "wss://api.openai.com/v1/live/sessions/live_opaque%2Fid%3Fpart%3Done/attach",
      );
      const sidebandHeaders = new Headers(socketRequests[0]?.headers);
      expect(sidebandHeaders.get("authorization")).toBe("Bearer platform-key");
      expect(sidebandHeaders.has("openai-alpha")).toBe(false);
      const socket = sockets[0]!;
      expect(socket.sent).toEqual([]);
      emitSideband(socket, {
        type: "session.input_transcript.delta",
        delta: "Check the ",
        start_ms: 0,
        end_ms: 500,
      });
      emitSideband(socket, {
        type: "session.input_transcript.delta",
        delta: "lights",
        start_ms: 500,
        end_ms: 900,
      });
      emitSideband(socket, {
        type: "session.delegation.created",
        delegation: { type: "delegation", target: "client", id: "delegation-public" },
        offset_ms: 900,
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
        ["user", "Check the lights", true],
      ]);
      expect(runAgentConsult).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringContaining("Check the lights") }),
      );
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual({
          type: "session.commentary.append",
          delegation_id: "delegation-public",
          content: "Done",
        }),
      );

      const closing = realtime.broker.cancelBrowserSession(reservation);
      expect(socket.closed).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      expect(realtime.getSessionCounts().reservations).toBe(1);
      expect(parseSent(socket)).toContainEqual({ type: "session.close" });
      emitSideband(socket, {
        type: "session.output_transcript.delta",
        delta: "Final spoken text.",
        start_ms: 1_000,
        end_ms: 1_500,
      });
      emitSideband(socket, {
        type: "session.delegation.created",
        delegation: { type: "delegation", target: "client", id: "late" },
        offset_ms: 1_500,
      });
      expect(runAgentConsult).toHaveBeenCalledOnce();
      emitSideband(socket, { type: "session.closed", reason: "close_requested" });
      await closing;
      await reentrantClose;
      expect(onTranscript).toHaveBeenLastCalledWith("assistant", "Final spoken text.", true);
      expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
      expect(socket.closed).toBe(true);
      expect(fetchImpl).toHaveBeenCalledOnce();
      await realtime.cleanup();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      for (const socket of sockets) {
        if (!socket.closed) {
          emitSideband(socket, { type: "session.closed", reason: "close_requested" });
        }
      }
      await realtime.cleanup();
    }
  });

  it.each([false, true])(
    "retains HTTP hangup fallback when sideband finalization is incomplete (retry=%s)",
    async (retry) => {
      let hangups = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (url) => {
        if (url === HANGUP_URL) {
          hangups += 1;
          return new Response(null, { status: retry && hangups === 1 ? 503 : 204 });
        }
        return liveResponse();
      });
      const fixture = createBroker({ fetchImpl });
      const onTranscript = vi.fn();
      const onClose = vi.fn();
      try {
        const reservation = await reserveSession(fixture, { onTranscript, onClose });
        const response = createResponseHarness();
        await fixture.realtime.handler(
          createRequest({ token: reservation.clientSecret, body: SDP }),
          response.res,
        );
        const socket = fixture.sockets[0]!;
        vi.useFakeTimers();
        const closing = Promise.resolve(fixture.realtime.broker.cancelBrowserSession(reservation));
        const result = closing.then(
          () => undefined,
          (error: unknown) => error,
        );
        emitSideband(socket, {
          type: "session.output_transcript.delta",
          delta: "Tail before timeout.",
          start_ms: 0,
          end_ms: 100,
        });
        expect(hangups).toBe(0);
        expect(fixture.realtime.getSessionCounts().reservations).toBe(1);
        await vi.advanceTimersByTimeAsync(15_000);
        const error = await result;
        expect(error instanceof Error).toBe(retry);
        expect(onTranscript).toHaveBeenLastCalledWith("assistant", "Tail before timeout.", true);
        expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
        expect(hangups).toBe(1);
        expect(fixture.realtime.getSessionCounts().reservations).toBe(retry ? 1 : 0);
        if (retry) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(hangups).toBe(retry ? 2 : 1);
        expect(fixture.realtime.getSessionCounts().reservations).toBe(0);
        expect(socket.closed).toBe(true);
      } finally {
        for (const socket of fixture.sockets) {
          if (!socket.closed) {
            emitSideband(socket, { type: "session.closed", reason: "close_requested" });
          }
        }
        vi.useRealTimers();
        await fixture.realtime.cleanup();
      }
    },
  );

  it.each(["malformed answer", "sideband startup failure"])(
    "hangs up an allocated session after %s before exposing an answer",
    async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>(async (url) =>
        url === HANGUP_URL
          ? new Response(null, { status: 204 })
          : liveResponse(failure === "malformed answer" ? " " : SDP),
      );
      const fixture = createBroker({
        fetchImpl,
        socketFactory: () => {
          const socket = new FakeSocket("manual");
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.emit("open");
            socket.emit("error", new Error("sideband failed before answer delivery"));
          });
          return socket;
        },
      });
      try {
        const reservation = await reserveSession(fixture);
        const response = createResponseHarness();
        await fixture.realtime.handler(
          createRequest({ token: reservation.clientSecret, body: SDP }),
          response.res,
        );
        expect(response.res.statusCode).toBe(502);
        expect(response.readBody()).not.toContain(SDP);
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([LIVE_URL, HANGUP_URL]);
        expect(fixture.sockets).toHaveLength(failure === "malformed answer" ? 0 : 1);
        expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
        expect(fixture.realtime.getSessionCounts()).toEqual({
          pending: 0,
          inFlight: 0,
          active: 0,
          reservations: 0,
        });
      } finally {
        await fixture.realtime.cleanup();
      }
    },
  );

  it("hangs up a session allocated after cancellation without attaching its sideband", async () => {
    const creation = createDeferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      url === HANGUP_URL ? new Response(null, { status: 204 }) : creation.promise,
    );
    const fixture = createBroker({ fetchImpl });
    try {
      const reservation = await reserveSession(fixture);
      const response = createResponseHarness();
      const handling = fixture.realtime.handler(
        createRequest({ token: reservation.clientSecret, body: SDP }),
        response.res,
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
      const canceling = fixture.realtime.broker.cancelBrowserSession(reservation);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      creation.resolve(liveResponse());
      await Promise.all([handling, canceling]);

      expect(response.res.statusCode).toBe(502);
      expect(fixture.socketRequests).toEqual([]);
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([LIVE_URL, HANGUP_URL]);
      expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
        "Bearer platform-key",
      );
      expect(fixture.realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });
    } finally {
      creation.resolve(liveResponse());
      await fixture.realtime.cleanup();
    }
  });
});
