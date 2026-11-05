import type { EventEmitter } from "node:events";
import { convertPcmToMulaw8k } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, expect, it, vi } from "vitest";
import { RealtimeAudioPacer } from "../webhook/realtime-audio-pacer.js";
import type { RealtimeMediaTransport } from "../webhook/realtime-handler.js";
import { StreamFrameAdapter } from "../webhook/stream-frame-adapter.js";
import { connectLiveKitAudio, type LiveKitAudioParams } from "./livekit-audio.js";

const mock = vi.hoisted(() => ({
  capture: vi.fn(async (_frame: { data: Int16Array }) => {}),
  playout: vi.fn(async () => {}),
  queueMs: 0,
  clear: vi.fn(),
  close: vi.fn(async () => {}),
  publish: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  subscribed: vi.fn(),
  streams: 0,
  room: undefined as EventEmitter | undefined,
  input: undefined as
    | ReadableStreamDefaultController<{ data: Int16Array; sampleRate: number }>
    | undefined,
}));

vi.mock("@livekit/rtc-node", async () => {
  const { EventEmitter } = await import("node:events");
  class Room extends EventEmitter {
    name = "openclaw-call-test";
    remoteParticipants = new Map([
      [
        "sip-test",
        {
          identity: "sip-test",
          sid: "PA_test",
          trackPublications: new Map([["TR_test", { kind: 1, setSubscribed: mock.subscribed }]]),
        },
      ],
    ]);
    localParticipant = { publishTrack: mock.publish };
    constructor() {
      super();
      mock.room = this;
    }
    connect = mock.connect;
    disconnect = mock.disconnect;
  }
  return {
    Room,
    AudioSource: class {
      captureFrame = mock.capture;
      clearQueue = mock.clear;
      close = mock.close;
      waitForPlayout = mock.playout;
      get queuedDuration() {
        return mock.queueMs;
      }
    },
    AudioFrame: class {
      constructor(
        public data: Int16Array,
        public sampleRate: number,
        public numChannels: number,
        public samplesPerChannel: number,
      ) {}
    },
    AudioStream: class {
      getReader() {
        mock.streams++;
        return new ReadableStream<{ data: Int16Array; sampleRate: number }>({
          start(controller) {
            mock.input = controller;
          },
        }).getReader();
      }
    },
    LocalAudioTrack: { createAudioTrack: vi.fn(() => ({})) },
    TrackPublishOptions: class {
      constructor(public options: unknown) {}
    },
    TrackSource: { SOURCE_MICROPHONE: 2 },
    TrackKind: { KIND_AUDIO: 1 },
    RoomEvent: {
      ParticipantConnected: "participantConnected",
      TrackPublished: "trackPublished",
      ParticipantDisconnected: "participantDisconnected",
      Disconnected: "disconnected",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
    },
  };
});

function harness() {
  let transport: RealtimeMediaTransport | undefined;
  const sendAudio = vi.fn();
  const endCall = vi.fn(async () => {});
  let played!: () => void;
  const playedPromise = new Promise<void>((resolve) => {
    played = resolve;
  });
  const acknowledgeMark = vi.fn((_name: string) => played());
  const onDisconnect = vi.fn();
  const handler: LiveKitAudioParams["handler"] = {
    attachRoomTransport: vi.fn(async (params) => {
      transport = params.transport;
      return { sendAudio, endCall, acknowledgeMark };
    }),
  };
  const params: LiveKitAudioParams = {
    url: "wss://livekit.example.test",
    token: "synthetic-room-token",
    room: "openclaw-call-test",
    identity: "sip-test",
    participantSid: "PA_test",
    callId: "call-test",
    handler,
    isCurrent: () => true,
    onDisconnect,
  };
  return {
    params,
    sendAudio,
    endCall,
    acknowledgeMark,
    playedPromise,
    onDisconnect,
    transport: () => transport!,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mock.input = undefined;
  mock.streams = 0;
  mock.room = undefined;
});

it("bridges supported RTC mono PCM and telephony audio, confirms marks and clears playback", async () => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  expect(mock.publish).toHaveBeenCalledOnce();
  expect(mock.subscribed).toHaveBeenCalledWith(true);
  expect(h.transport().readyState).toBe(1);
  mock.room!.emit(
    "trackSubscribed",
    { kind: 1, sid: "TR_test" },
    {},
    { identity: "sip-test", sid: "PA_test" },
  );
  const samples = new Int16Array([0, 1000, -1000, 3000]);
  mock.input!.enqueue({ data: samples, sampleRate: 8000 });
  // An explicit input delivery promise avoids real timers or polling.
  await Promise.resolve();
  await Promise.resolve();
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const mulaw = convertPcmToMulaw8k(pcm, 8000);
  expect(h.sendAudio).toHaveBeenCalledWith(mulaw);
  h.transport().send(
    JSON.stringify({ event: "media", media: { payload: mulaw.toString("base64") } }),
  );
  h.transport().send(JSON.stringify({ event: "mark", mark: { name: "played" } }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await h.playedPromise;
  expect(h.acknowledgeMark).toHaveBeenCalledWith("played");
  expect(mock.capture).toHaveBeenCalledOnce();
  expect(Array.from(mock.capture.mock.calls[0]![0].data)).toEqual([0, 988, -988, 3004]);
  h.transport().send(JSON.stringify({ event: "clear" }));
  expect(mock.clear).toHaveBeenCalledOnce();
  await connection.close();
  await connection.close();
  expect(h.endCall).toHaveBeenCalledOnce();
  expect(mock.disconnect).toHaveBeenCalledOnce();
  expect(mock.close).toHaveBeenCalledOnce();
});

it("fails closed on room/SIP SID mismatch without publishing audio or leaking token errors", async () => {
  const h = harness();
  await expect(connectLiveKitAudio({ ...h.params, participantSid: "PA_foreign" })).rejects.toThrow(
    "LiveKit RTC audio connection failed",
  );
  expect(mock.publish).not.toHaveBeenCalled();
  expect(mock.disconnect).toHaveBeenCalledOnce();
});

it("terminates on foreign peer or RTC disconnect and prevents audio after cancellation", async () => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  mock.room!.emit("participantConnected", { identity: "foreign", sid: "PA_foreign" });
  expect(h.onDisconnect).toHaveBeenCalledExactlyOnceWith("error");
  expect(h.transport().readyState).toBe(3);
  h.transport().send(JSON.stringify({ event: "media", media: { payload: "////" } }));
  await connection.close();
  expect(mock.capture).not.toHaveBeenCalled();
});

it.each([false, true])(
  "does not connect when admission retires during the native SDK import (initially current: %s)",
  async (initiallyCurrent) => {
    const h = harness();
    let current = initiallyCurrent;
    const admission = connectLiveKitAudio({ ...h.params, isCurrent: () => current });
    // The production entry point has yielded at its dynamic import. Retire the
    // manager admission before the SDK continuation can submit a room token.
    current = false;
    await expect(admission).rejects.toThrow("LiveKit RTC audio connection failed");
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.publish).not.toHaveBeenCalled();
    expect(h.params.handler.attachRoomTransport).not.toHaveBeenCalled();
    expect(mock.disconnect).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
  },
);

it("acknowledges a 160ms prefix during sustained captures and cancels stale marks on clear/close", async () => {
  vi.useFakeTimers();
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  try {
    mock.queueMs = 160;
    const media = JSON.stringify({ event: "media", media: { payload: "////" } });
    h.transport().send(media);
    h.transport().send(JSON.stringify({ event: "mark", mark: { name: "prefix" } }));
    for (let i = 0; i < 8; i++) {
      h.transport().send(media);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(mock.capture).toHaveBeenCalledTimes(9);
    expect(h.acknowledgeMark).toHaveBeenCalledWith("prefix");
    expect(mock.playout).not.toHaveBeenCalled();
    h.transport().send(JSON.stringify({ event: "mark", mark: { name: "cleared" } }));
    await vi.advanceTimersByTimeAsync(0);
    h.transport().send(JSON.stringify({ event: "clear" }));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.acknowledgeMark).not.toHaveBeenCalledWith("cleared");
    h.transport().send(JSON.stringify({ event: "mark", mark: { name: "closed" } }));
    await vi.advanceTimersByTimeAsync(0);
    await connection.close();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.acknowledgeMark).not.toHaveBeenCalledWith("closed");
  } finally {
    await connection.close();
    mock.queueMs = 0;
    vi.useRealTimers();
  }
});

it.each([1008, 1011, 1013])("propagates transport error close %s", async (code) => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  h.transport().close(code);
  expect(h.onDisconnect).toHaveBeenCalledWith("error");
  await connection.close();
});

it("advances pacer truncation position mid-response and clears pending generation marks", async () => {
  vi.useFakeTimers();
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  const pacer = new RealtimeAudioPacer({
    serializer: new StreamFrameAdapter("twilio"),
    send: (raw) => {
      h.transport().send(raw);
      return true;
    },
  });
  h.acknowledgeMark.mockImplementation((name) => {
    pacer.acknowledgeMark(name);
  });
  try {
    mock.queueMs = 160;
    pacer.sendAudio(Buffer.alloc(8000, 255), { itemId: "assistant-turn" });
    await vi.advanceTimersByTimeAsync(500);
    const played = pacer.getPlaybackState()[0]!.audioEndMs;
    expect(played).toBeGreaterThanOrEqual(250);
    expect(played).toBeLessThan(1000);
    const count = h.acknowledgeMark.mock.calls.length;
    pacer.clearAudio();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.acknowledgeMark.mock.calls).toHaveLength(count);
    expect(pacer.getPlaybackState()).toEqual([]);
  } finally {
    pacer.close();
    await connection.close();
    mock.queueMs = 0;
    vi.useRealTimers();
  }
});

it.each(["capture", "reader"] as const)("classifies %s failure as error", async (failure) => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  if (failure === "capture") {
    mock.capture.mockRejectedValueOnce(new Error("capture failed"));
    h.transport().send(JSON.stringify({ event: "media", media: { payload: "////" } }));
  } else {
    mock.room!.emit(
      "trackSubscribed",
      { kind: 1, sid: "TR_error" },
      {},
      { identity: "sip-test", sid: "PA_test" },
    );
    mock.input!.error(new Error("reader failed"));
  }
  await vi.waitFor(() => expect(h.onDisconnect).toHaveBeenCalledExactlyOnceWith("error"));
  await connection.close();
});

it.each(["disconnected", "participantDisconnected"])(
  "classifies normal %s as completed",
  async (event) => {
    const h = harness();
    const connection = await connectLiveKitAudio(h.params);
    mock.room!.emit(event, { identity: "sip-test" });
    expect(h.onDisconnect).toHaveBeenCalledExactlyOnceWith("completed");
    await connection.close();
  },
);

it.each(["reader-completion", "unsubscribe"] as const)(
  "delivers caller audio from a same-SID track resubscribed after %s",
  async (retirement) => {
    const h = harness();
    const connection = await connectLiveKitAudio(h.params);
    const peer = { identity: "sip-test", sid: "PA_test" };
    const subscribe = () =>
      mock.room!.emit("trackSubscribed", { kind: 1, sid: "TR_same" }, {}, peer);
    const deliver = async (value: number) => {
      mock.input!.enqueue({ data: new Int16Array([value]), sampleRate: 8000 });
      await vi.waitFor(() => expect(h.sendAudio).toHaveBeenCalledTimes(value));
    };
    subscribe();
    // A duplicate event while the first reader is live must not start a second reader.
    subscribe();
    expect(mock.streams).toBe(1);
    await deliver(1);
    if (retirement === "reader-completion") {
      mock.input!.close();
      await vi.waitFor(() => expect(mock.streams).toBe(1));
      await Promise.resolve();
    } else {
      mock.room!.emit("trackUnsubscribed", { kind: 1, sid: "TR_same" }, {}, peer);
    }
    subscribe();
    expect(mock.streams).toBe(2);
    await deliver(2);
    await connection.close();
    expect(h.sendAudio).toHaveBeenCalledTimes(2);
  },
);

it("does not let a retired reader's completion unregister its replacement", async () => {
  const h = harness();
  const connection = await connectLiveKitAudio(h.params);
  const peer = { identity: "sip-test", sid: "PA_test" };
  mock.room!.emit("trackSubscribed", { kind: 1, sid: "TR_same" }, {}, peer);
  const first = mock.input!;
  mock.room!.emit("trackUnsubscribed", { kind: 1, sid: "TR_same" }, {}, peer);
  mock.room!.emit("trackSubscribed", { kind: 1, sid: "TR_same" }, {}, peer);
  expect(mock.streams).toBe(2);
  // Let the first reader's cancellation settle, then duplicate the live replacement.
  await Promise.resolve();
  await Promise.resolve();
  try {
    first.close();
  } catch {
    // Already cancelled by unsubscribe; completion has nothing further to signal.
  }
  mock.room!.emit("trackSubscribed", { kind: 1, sid: "TR_same" }, {}, peer);
  expect(mock.streams).toBe(2);
  await connection.close();
});
