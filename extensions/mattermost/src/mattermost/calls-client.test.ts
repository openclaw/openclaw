import { inflateSync } from "node:zlib";
import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import {
  connectMattermostCall,
  type MattermostCallsPeerConnection,
  type MattermostCallsRtcFactory,
  type MattermostCallsWebSocket,
} from "./calls-client.js";

type Handler = (...args: unknown[]) => unknown;

class FakeWebSocket implements MattermostCallsWebSocket {
  readonly handlers = new Map<string, Handler>();
  readonly sent: Array<string | Buffer> = [];

  on(event: string, listener: Handler): void {
    this.handlers.set(event, listener);
  }

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close = vi.fn();
  terminate = vi.fn();
  ping = vi.fn();

  emit(event: string, ...args: unknown[]): unknown {
    return this.handlers.get(event)?.(...args);
  }

  async message(payload: unknown): Promise<void> {
    await this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function textMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function mediaMapMessage(mediaMap: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(encode(9)), Buffer.from(encode(mediaMap))]);
}

function createCallsFetch(params?: {
  config?: Record<string, unknown>;
  turnCredentials?: unknown[];
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/plugins/com.mattermost.calls/api/v1/config") {
      return Response.json(
        params?.config ?? {
          ICEServersConfigs: [],
          NeedsTURNCredentials: false,
        },
      );
    }
    if (pathname === "/plugins/com.mattermost.calls/api/v1/turn-credentials") {
      return Response.json(params?.turnCredentials ?? []);
    }
    return new Response("not found", { status: 404 });
  });
}

async function waitForWebSocketListeners(ws: FakeWebSocket): Promise<void> {
  await vi.waitFor(() => expect(ws.handlers.has("open")).toBe(true));
}

function createRtc() {
  const peerHandlers = new Map<string, Handler>();
  const dataChannel = {
    binaryType: "",
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
  };
  const audioSource = {
    createTrack: vi.fn(() => ({ id: "local-audio", stop: vi.fn() })),
    onData: vi.fn(),
  };
  const peer: MattermostCallsPeerConnection = {
    addIceCandidate: vi.fn(async () => undefined),
    addTrack: vi.fn(),
    close: vi.fn(),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" })),
    createDataChannel: vi.fn(() => dataChannel),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    get remoteDescription() {
      return null;
    },
    on(event, listener) {
      peerHandlers.set(event, listener);
    },
  };
  const sinks: Array<{ ondata?: (event: { samples: Int16Array }) => void; stop: () => void }> = [];
  const rtc: MattermostCallsRtcFactory = {
    createAudioSink: vi.fn(() => {
      const sink = { stop: vi.fn() };
      sinks.push(sink);
      return sink;
    }),
    createAudioSource: vi.fn(() => audioSource),
    createPeerConnection: vi.fn(() => peer),
  };
  return { audioSource, dataChannel, peer, peerHandlers, rtc, sinks };
}

async function joinCall(params?: {
  abortSignal?: AbortSignal;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  decodeAudioFile?: (path: string) => Promise<Buffer>;
}) {
  const ws = new FakeWebSocket();
  const { audioSource, dataChannel, peer, peerHandlers, rtc, sinks } = createRtc();
  const onAudio = vi.fn();
  const onVoice = vi.fn();
  const pending = connectMattermostCall({
    baseUrl: "https://mattermost.test",
    botToken: "test-token",
    callbacks: { onAudio, onVoice },
    channelId: "dm-channel",
    fetchImpl: params?.fetchImpl ?? createCallsFetch(),
    rtc,
    webSocketFactory: () => ws,
    wsUrl: "ws://mattermost.test/api/v4/websocket",
    ...params,
  });

  await waitForWebSocketListeners(ws);
  ws.emit("open");
  await ws.message({ event: "hello", data: { connection_id: "conn-1" } });
  await ws.message({
    event: "custom_com.mattermost.calls_join",
    data: { connID: "conn-1" },
  });
  const session = await pending;
  return {
    audioSource,
    dataChannel,
    onAudio,
    onVoice,
    peer,
    peerHandlers,
    rtc,
    session,
    sinks,
    ws,
  };
}

describe("Mattermost Calls client", () => {
  it("ignores join and signaling events for other Calls connection ids", async () => {
    const ws = new FakeWebSocket();
    const { peer, rtc } = createRtc();
    const pending = connectMattermostCall({
      baseUrl: "https://mattermost.test",
      botToken: "test-token",
      callbacks: { onAudio: vi.fn(), onVoice: vi.fn() },
      channelId: "dm-channel",
      fetchImpl: createCallsFetch(),
      rtc,
      webSocketFactory: () => ws,
      wsUrl: "ws://mattermost.test/api/v4/websocket",
    });

    await waitForWebSocketListeners(ws);
    ws.emit("open");
    await ws.message({ event: "hello", data: { connection_id: "conn-1" } });
    await ws.message({
      event: "custom_com.mattermost.calls_join",
      data: { connID: "conn-2" },
    });
    let foreignSession: Awaited<ReturnType<typeof connectMattermostCall>> | undefined;
    await Promise.race([
      pending.then((session) => {
        foreignSession = session;
      }),
      Promise.resolve(),
    ]);
    try {
      expect(rtc.createPeerConnection).not.toHaveBeenCalled();
    } finally {
      await foreignSession?.close();
    }

    await ws.message({
      event: "custom_com.mattermost.calls_join",
      data: { connID: "conn-1" },
    });
    const session = await pending;
    try {
      await ws.message({
        event: "custom_com.mattermost.calls_signal",
        data: {
          connID: "conn-2",
          data: JSON.stringify({ type: "offer", sdp: "foreign-offer" }),
        },
      });
      expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("configures the peer with Mattermost Calls ICE servers and generated TURN credentials", async () => {
    const fetchImpl = createCallsFetch({
      config: {
        ICEServersConfigs: [{ urls: "stun:stun.example.com:3478" }],
        NeedsTURNCredentials: true,
      },
      turnCredentials: [
        {
          credential: "turn-pass",
          urls: ["turn:turn.example.com:3478"],
          username: "turn-user",
        },
      ],
    });
    const { rtc, session } = await joinCall({ fetchImpl });
    try {
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        "https://mattermost.test/plugins/com.mattermost.calls/api/v1/config",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        "https://mattermost.test/plugins/com.mattermost.calls/api/v1/turn-credentials",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        }),
      );
      expect(rtc.createPeerConnection).toHaveBeenCalledWith({
        iceServers: [
          { urls: "stun:stun.example.com:3478" },
          {
            credential: "turn-pass",
            urls: ["turn:turn.example.com:3478"],
            username: "turn-user",
          },
        ],
      });
    } finally {
      await session.close();
    }
  });

  it("treats nullable Mattermost Calls ICE config as empty", async () => {
    const fetchImpl = createCallsFetch({
      config: {
        ICEServersConfigs: null,
        NeedsTURNCredentials: null,
      },
    });
    const { rtc, session } = await joinCall({ fetchImpl });
    try {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(rtc.createPeerConnection).toHaveBeenCalledWith({ iceServers: [] });
    } finally {
      await session.close();
    }
  });

  it("authenticates, joins, and forwards voice activity and decoded audio", async () => {
    const { dataChannel, onAudio, onVoice, peerHandlers, sinks, ws } = await joinCall();
    const messages = textMessages(ws);

    expect(messages[0]).toMatchObject({
      action: "authentication_challenge",
      data: { token: "test-token" },
    });
    expect(messages[1]).toMatchObject({
      action: "custom_com.mattermost.calls_join",
      data: {
        av1Support: false,
        channelID: "dm-channel",
        dcSignaling: false,
        jobID: "",
      },
    });

    await ws.message({
      event: "custom_com.mattermost.calls_user_voice_on",
      data: { session_id: "speaker-session", userID: "human-user" },
    });
    await ws.message({
      event: "custom_com.mattermost.calls_user_voice_off",
      data: { session_id: "speaker-session", userID: "human-user" },
    });
    expect(onVoice).toHaveBeenNthCalledWith(1, {
      sessionId: "speaker-session",
      speaking: true,
      userId: "human-user",
    });
    expect(onVoice).toHaveBeenNthCalledWith(2, {
      sessionId: "speaker-session",
      speaking: false,
      userId: "human-user",
    });

    await ws.message({
      event: "custom_com.mattermost.calls_signal",
      data: {
        data: JSON.stringify({
          type: "offer",
          sdp: [
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "a=mid:3",
            "a=msid:remote-stream voice_speaker-session_random",
            "",
          ].join("\r\n"),
        }),
      },
    });
    peerHandlers.get("track")?.({
      track: { id: "random-track-id" },
      transceiver: { mid: "3" },
    });
    dataChannel.onmessage?.({
      data: mediaMapMessage({ 3: { type: "voice", sender_id: "receiver-session" } }),
    });
    sinks[0]?.ondata?.({ samples: new Int16Array([1, 2]) });
    expect(onAudio).toHaveBeenCalledWith({
      samples: new Int16Array([1, 1, 2, 2]),
      sessionId: "speaker-session",
    });
  });

  it("uses the media map sender id when SDP and track ids do not expose the voice session", async () => {
    const { dataChannel, onAudio, peerHandlers, session, sinks } = await joinCall();
    try {
      peerHandlers.get("track")?.({
        track: { id: "ordinary-track-id" },
        transceiver: { mid: "3" },
      });
      dataChannel.onmessage?.({
        data: mediaMapMessage({ 3: { type: "voice", sender_id: "mapped-session" } }),
      });
      sinks[0]?.ondata?.({ samples: new Int16Array([7, 8]) });

      expect(onAudio).toHaveBeenCalledWith({
        samples: new Int16Array([7, 7, 8, 8]),
        sessionId: "mapped-session",
      });
    } finally {
      await session.close();
    }
  });

  it("exchanges WebRTC signaling in the Calls wire format", async () => {
    const { peer, peerHandlers, ws } = await joinCall();

    await peerHandlers.get("negotiationneeded")?.();
    const binary = ws.sent.find((entry): entry is Buffer => Buffer.isBuffer(entry));
    expect(binary).toBeDefined();
    const envelope = decode(binary ?? Buffer.alloc(0)) as {
      action: string;
      data: { data: Uint8Array };
    };
    expect(envelope.action).toBe("custom_com.mattermost.calls_sdp");
    expect(JSON.parse(inflateSync(envelope.data.data).toString())).toEqual({
      type: "offer",
      sdp: "offer-sdp",
    });

    await ws.message({
      event: "custom_com.mattermost.calls_signal",
      data: { data: JSON.stringify({ type: "offer", sdp: "remote-offer" }) },
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "remote-offer",
    });
    expect(peer.createAnswer).toHaveBeenCalled();

    peerHandlers.get("icecandidate")?.({
      candidate: { toJSON: () => ({ candidate: "local-candidate" }) },
    });
    expect(textMessages(ws).at(-1)).toMatchObject({
      action: "custom_com.mattermost.calls_ice",
      data: { data: JSON.stringify({ candidate: "local-candidate" }) },
    });
  });

  it("waits for connection settling, plays PCM, then leaves cleanly", async () => {
    let currentTime = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const frame = Buffer.alloc(480 * 2 * 2, 1);
    const { audioSource, peer, session, sinks, ws } = await joinCall({
      decodeAudioFile: async () => frame,
      now: () => currentTime,
      sleep,
    });

    await session.play({ audioPath: "/tmp/reply.mp3" });

    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(3_000);
    expect(audioSource.onData).toHaveBeenCalledWith(
      expect.objectContaining({
        bitsPerSample: 16,
        channelCount: 2,
        numberOfFrames: 480,
        sampleRate: 48_000,
      }),
    );
    const playbackCalls = vi.mocked(audioSource.onData).mock.calls;
    const firstSamples = playbackCalls[0]?.[0].samples;
    const firstAudibleCallIndex = playbackCalls.findIndex((call) =>
      Array.from(call[0].samples).some((sample) => sample !== 0),
    );
    const lastSamples = playbackCalls.at(-1)?.[0].samples;
    expect(firstSamples && Array.from(firstSamples).every((sample) => sample === 0)).toBe(true);
    expect(firstAudibleCallIndex).toBeGreaterThan(0);
    expect(lastSamples && Array.from(lastSamples).every((sample) => sample === 0)).toBe(true);
    expect(textMessages(ws).map((message) => message.action)).toEqual(
      expect.arrayContaining([
        "custom_com.mattermost.calls_unmute",
        "custom_com.mattermost.calls_mute",
      ]),
    );

    await session.close();
    expect(textMessages(ws).at(-1)).toMatchObject({
      action: "custom_com.mattermost.calls_leave",
    });
    expect(sinks.every((sink) => vi.mocked(sink.stop).mock.calls.length === 1)).toBe(true);
    expect(peer.close).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
  });

  it("stops playback when the playback signal is aborted", async () => {
    let currentTime = 10_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const frameBytes = 480 * 2 * 2;
    const pcm = Buffer.alloc(frameBytes * 3, 1);
    const abort = new AbortController();
    const { audioSource, session, ws } = await joinCall({
      decodeAudioFile: async () => pcm,
      now: () => currentTime,
      sleep,
    });
    vi.mocked(audioSource.onData).mockImplementationOnce(() => abort.abort());

    await session.play({ audioPath: "/tmp/reply.mp3" }, { signal: abort.signal });

    expect(audioSource.onData).toHaveBeenCalledTimes(1);
    expect(textMessages(ws).map((message) => message.action)).toEqual(
      expect.arrayContaining([
        "custom_com.mattermost.calls_unmute",
        "custom_com.mattermost.calls_mute",
      ]),
    );
    await session.close();
  });

  it("releases WebRTC resources when the signaling socket disconnects", async () => {
    const { dataChannel, peer, peerHandlers, session, sinks, ws } = await joinCall();
    dataChannel.onmessage?.({
      data: mediaMapMessage({ 3: { type: "voice", sender_id: "speaker-session" } }),
    });
    peerHandlers.get("track")?.({
      track: { id: "voice_speaker-session_random" },
      transceiver: { mid: "3" },
    });

    await ws.emit("close", 1006, Buffer.from("network lost"));
    expect(session.closed).toBeDefined();
    await session.closed;

    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(sinks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("leaves the call when the gateway shuts down", async () => {
    const abort = new AbortController();
    const { peer, ws } = await joinCall({ abortSignal: abort.signal });

    abort.abort();
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));

    expect(textMessages(ws).at(-1)).toMatchObject({
      action: "custom_com.mattermost.calls_leave",
    });
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
});
