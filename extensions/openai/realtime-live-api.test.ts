import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceGatewayControl } from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createBroker,
  createRequest,
  createResponseHarness,
  emitSideband,
  FakeSocket,
  parseSent,
  reserveSession as reserveBrowserSession,
} from "./realtime-quicksilver.test-helpers.js";

const LIVE_URL = "https://api.openai.com/v1/live/sessions";
const SESSION_ID = "live_opaque/id?part=one";
const HANGUP_URL = `${LIVE_URL}/live_opaque%2Fid%3Fpart%3Done/hangup`;
const SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
type Broker = ReturnType<typeof createBroker>;

function transcript(
  socket: FakeSocket,
  role: "input" | "output",
  delta: string,
  start_ms: number,
  end_ms: number,
) {
  emitSideband(socket, { type: `session.${role}_transcript.delta`, delta, start_ms, end_ms });
}

function delegate(socket: FakeSocket, id: string, offset_ms: number) {
  emitSideband(socket, {
    type: "session.delegation.created",
    delegation: { type: "delegation", target: "client", id },
    offset_ms,
  });
}

function liveBroker(params: Parameters<typeof createBroker>[0], beforeCleanup = () => {}) {
  const fixture = createBroker(params);
  onTestFinished(async () => {
    beforeCleanup();
    for (const socket of fixture.sockets) {
      if (!socket.closed) {
        emitSideband(socket, { type: "session.closed", reason: "close_requested" });
      }
    }
    vi.useRealTimers();
    await fixture.realtime.cleanup();
  });
  return fixture;
}

function liveResponse(sdp = SDP): Response {
  return Response.json(
    { session: { id: SESSION_ID }, transport: { type: "webrtc", sdp } },
    { status: 201 },
  );
}

function liveFetch(create = () => Promise.resolve(liveResponse()), hangup = () => 204) {
  return vi.fn<typeof fetch>(async (url) =>
    url === HANGUP_URL ? new Response(null, { status: hangup() }) : create(),
  );
}

function reserveSession(
  fixture: Broker,
  gatewayControl?: Pick<RealtimeVoiceGatewayControl, "onTranscript" | "onClose" | "onError">,
) {
  return reserveBrowserSession(fixture.realtime, {
    providerConfig: {},
    model: "gpt-live-1",
    instructions: "Answer briefly.",
    initialItems: [{ role: "user", text: "The room is the kitchen." }],
    runAgentConsult: fixture.runAgentConsult,
    ...(gatewayControl ? { gatewayControl: { bindBridge: vi.fn(), ...gatewayControl } } : {}),
  });
}

function handleOffer(fixture: Broker, token: string, body = SDP) {
  const response = createResponseHarness();
  const handling = fixture.realtime.handler(createRequest({ token, body }), response.res);
  return { response, handling };
}

async function answerOffer(fixture: Broker, token: string, body = SDP) {
  const { response, handling } = handleOffer(fixture, token, body);
  await handling;
  return response;
}

const EMPTY_COUNTS = { pending: 0, inFlight: 0, active: 0, reservations: 0 };

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
    const fixture = liveBroker({ fetchImpl }, () => {
      fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    });
    const onClose = vi.fn();
    const onError = vi.fn();
    const reservation = await reserveSession(fixture, { onClose, onError });
    const response = await answerOffer(fixture, reservation.clientSecret);
    expect(response.res.statusCode).toBe(200);
    emitSideband(fixture.sockets[0]!, { type: "session.closed", reason });
    await fixture.realtime.cleanup();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fixture.sockets[0]?.closed).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(onError).toHaveBeenCalledTimes(outcome === "error" ? 1 : 0);
    expect(fixture.realtime.getSessionCounts()).toEqual(EMPTY_COUNTS);
  },
);

it("accepts an audio and application offer, delegates, and drains final text before closing", async () => {
  const fetchImpl = liveFetch();
  const fixture = liveBroker({ fetchImpl });
  const { realtime, sockets, socketRequests, runAgentConsult } = fixture;
  const onTranscript = vi.fn();
  const onClose = vi.fn();
  let reentrantClose: Promise<void> | undefined;
  const offeredSdp = `${SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
  const reservation = await reserveSession(fixture, { onTranscript, onClose });
  onClose.mockImplementation(() => {
    reentrantClose = Promise.resolve(realtime.broker.cancelBrowserSession(reservation));
  });
  expect(reservation.voice).toBe("marin");
  expect(JSON.stringify(reservation)).not.toContain("platform-key");
  const response = await answerOffer(fixture, reservation.clientSecret, offeredSdp);

  expect([response.res.statusCode, response.readBody()]).toEqual([200, SDP]);
  expect(response.setHeader).toHaveBeenCalledWith("content-type", "application/sdp");
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect([url, init?.method]).toEqual([LIVE_URL, "POST"]);
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
  transcript(socket, "input", "Check the ", 0, 500);
  transcript(socket, "input", "lights", 500, 900);
  delegate(socket, "delegation-public", 900);
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
  transcript(socket, "output", "Final spoken text.", 1_000, 1_500);
  delegate(socket, "late", 1_500);
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
});

it.each([false, true])(
  "retains HTTP hangup fallback when sideband finalization is incomplete (retry=%s)",
  async (retry) => {
    let hangups = 0;
    const fetchImpl = liveFetch(undefined, () => {
      hangups += 1;
      return retry && hangups === 1 ? 503 : 204;
    });
    const fixture = liveBroker({ fetchImpl });
    const onTranscript = vi.fn();
    const onClose = vi.fn();
    const reservation = await reserveSession(fixture, { onTranscript, onClose });
    await answerOffer(fixture, reservation.clientSecret);
    const socket = fixture.sockets[0]!;
    vi.useFakeTimers();
    const closing = Promise.resolve(fixture.realtime.broker.cancelBrowserSession(reservation));
    const result = closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    transcript(socket, "output", "Tail before timeout.", 0, 100);
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
  },
);

it.each(["malformed answer", "sideband startup failure"])(
  "hangs up an allocated session after %s before exposing an answer",
  async (failure) => {
    const fetchImpl = liveFetch(async () =>
      liveResponse(failure === "malformed answer" ? " " : SDP),
    );
    const fixture = liveBroker({
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
    const reservation = await reserveSession(fixture);
    const response = await answerOffer(fixture, reservation.clientSecret);
    expect(response.res.statusCode).toBe(502);
    expect(response.readBody()).not.toContain(SDP);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([LIVE_URL, HANGUP_URL]);
    expect(fixture.sockets).toHaveLength(failure === "malformed answer" ? 0 : 1);
    expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
    expect(fixture.realtime.getSessionCounts()).toEqual(EMPTY_COUNTS);
  },
);

it("hangs up a session allocated after cancellation without attaching its sideband", async () => {
  const creation = createDeferred<Response>();
  const fetchImpl = liveFetch(() => creation.promise);
  const fixture = liveBroker({ fetchImpl }, () => creation.resolve(liveResponse()));
  const reservation = await reserveSession(fixture);
  const { response, handling } = handleOffer(fixture, reservation.clientSecret);
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
  expect(fixture.realtime.getSessionCounts()).toEqual(EMPTY_COUNTS);
});
