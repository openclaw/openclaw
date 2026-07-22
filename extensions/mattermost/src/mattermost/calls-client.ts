// Mattermost plugin module implements the Calls WebSocket and WebRTC client.
import { deflateSync } from "node:zlib";
import { decodeMulti, encode } from "@msgpack/msgpack";
import wrtc from "@roamhq/wrtc";
import WebSocket from "ws";
import { z } from "zod";
import { normalizeMattermostBaseUrl, readMattermostError, type MattermostFetch } from "./client.js";
import { decodeAudioFileToStereo48k } from "./voice-audio.js";
import type { MattermostVoiceCallCallbacks, MattermostVoiceCallSession } from "./voice-worker.js";

const CALLS_PREFIX = "custom_com.mattermost.calls_";
const CALLS_PLUGIN_API_PREFIX = "/plugins/com.mattermost.calls/api/v1";
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_FRAME_MILLISECONDS = 10;
const AUDIO_FRAMES_PER_PACKET = (AUDIO_SAMPLE_RATE * AUDIO_FRAME_MILLISECONDS) / 1_000;
const AUDIO_BYTES_PER_PACKET = AUDIO_FRAMES_PER_PACKET * AUDIO_CHANNELS * 2;
const CONNECTION_SETTLE_MILLISECONDS = 3_000;
const UNMUTE_SETTLE_MILLISECONDS = 100;
const PLAYBACK_LEAD_IN_MILLISECONDS = 500;
const PLAYBACK_TRAILING_MILLISECONDS = 300;
const PLAYBACK_LEAD_IN_PACKETS = Math.ceil(
  PLAYBACK_LEAD_IN_MILLISECONDS / AUDIO_FRAME_MILLISECONDS,
);
const PLAYBACK_TRAILING_PACKETS = Math.ceil(
  PLAYBACK_TRAILING_MILLISECONDS / AUDIO_FRAME_MILLISECONDS,
);
const PING_INTERVAL_MILLISECONDS = 30_000;

type CallsHandler = (...args: unknown[]) => unknown;
const DATA_CHANNEL_MEDIA_MAP_MESSAGE = 9;

const MediaMapSchema = z.record(
  z.string(),
  z.object({
    sender_id: z.string(),
    type: z.string(),
  }),
);

type MattermostCallsMediaMap = z.infer<typeof MediaMapSchema>;

export type MattermostCallsDataChannel = {
  binaryType: string;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
};

export type MattermostCallsWebSocket = {
  on: (event: string, listener: CallsHandler) => void;
  send: (data: string | Buffer) => void;
  close: () => void;
  terminate: () => void;
  ping: () => void;
};

type SessionDescription = {
  type: string;
  sdp?: string;
};

type IceCandidate = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

const IceServerSchema = z
  .object({
    urls: z.union([z.string(), z.array(z.string())]),
    username: z.string().optional(),
    credential: z.string().optional(),
    credentialType: z.string().optional(),
  })
  .passthrough();

const CallsConfigSchema = z
  .object({
    ICEServersConfigs: z.array(IceServerSchema).nullish(),
    NeedsTURNCredentials: z.boolean().nullish(),
  })
  .passthrough();

const TurnCredentialsSchema = z.array(IceServerSchema);

export type MattermostCallsIceServer = z.infer<typeof IceServerSchema>;

export type MattermostCallsPeerConnection = {
  readonly remoteDescription: unknown;
  on: (event: "icecandidate" | "negotiationneeded" | "track", listener: CallsHandler) => void;
  addTrack: (track: unknown) => unknown;
  createDataChannel: (label: string) => MattermostCallsDataChannel;
  createOffer: () => Promise<SessionDescription>;
  createAnswer: () => Promise<SessionDescription>;
  setLocalDescription: (description: SessionDescription) => Promise<void>;
  setRemoteDescription: (description: SessionDescription) => Promise<void>;
  addIceCandidate: (candidate: IceCandidate) => Promise<void>;
  close: () => void;
};

type MattermostCallsAudioData = {
  samples: Int16Array;
  sampleRate?: number;
  channelCount?: number;
};

type MattermostCallsAudioSink = {
  ondata?: (event: MattermostCallsAudioData) => void;
  stop: () => void;
};

type MattermostCallsAudioSource = {
  createTrack: () => { stop?: () => void };
  onData: (data: {
    samples: Int16Array;
    sampleRate: number;
    bitsPerSample: number;
    channelCount: number;
    numberOfFrames: number;
  }) => void;
};

export type MattermostCallsRtcFactory = {
  createPeerConnection: (options: {
    iceServers: MattermostCallsIceServer[];
  }) => MattermostCallsPeerConnection;
  createAudioSource: () => MattermostCallsAudioSource;
  createAudioSink: (track: unknown) => MattermostCallsAudioSink;
};

const CallsEventSchema = z
  .object({
    event: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    broadcast: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type CallsEvent = z.infer<typeof CallsEventSchema>;

function defaultWebSocketFactory(url: string): MattermostCallsWebSocket {
  return new WebSocket(url) as unknown as MattermostCallsWebSocket;
}

function defaultRtcFactory(): MattermostCallsRtcFactory {
  return {
    createPeerConnection(options) {
      const peer = new wrtc.RTCPeerConnection({
        iceServers: options.iceServers,
      } as RTCConfiguration);
      return {
        get remoteDescription() {
          return peer.remoteDescription;
        },
        on(event, listener) {
          peer.addEventListener(event, listener as EventListener);
        },
        addTrack: (track) => peer.addTrack(track as MediaStreamTrack),
        createDataChannel: (label) =>
          peer.createDataChannel(label) as unknown as MattermostCallsDataChannel,
        createOffer: async () => await peer.createOffer(),
        createAnswer: async () => await peer.createAnswer(),
        setLocalDescription: async (description) => {
          await peer.setLocalDescription(description as RTCSessionDescriptionInit);
        },
        setRemoteDescription: async (description) => {
          await peer.setRemoteDescription(description as RTCSessionDescriptionInit);
        },
        addIceCandidate: async (candidate) => {
          await peer.addIceCandidate(candidate as RTCIceCandidateInit);
        },
        close: () => peer.close(),
      };
    },
    createAudioSource() {
      return new wrtc.nonstandard.RTCAudioSource();
    },
    createAudioSink(track) {
      return new wrtc.nonstandard.RTCAudioSink(track as MediaStreamTrack);
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function parseEvent(data: unknown): CallsEvent | undefined {
  const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  try {
    const result = CallsEventSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function parseMediaMapMessage(value: unknown): MattermostCallsMediaMap | undefined {
  const bytes = toUint8Array(value);
  if (!bytes) {
    return undefined;
  }
  const values = decodeMulti(bytes);
  const first = values.next();
  if (first.done || first.value !== DATA_CHANNEL_MEDIA_MAP_MESSAGE) {
    return undefined;
  }
  const second = values.next();
  if (second.done) {
    return undefined;
  }
  const parsed = MediaMapSchema.safeParse(second.value);
  return parsed.success ? parsed.data : undefined;
}

function parseVoiceTrackSessionId(trackId: string): string | undefined {
  const match = /^voice_([^_]+)_/.exec(trackId);
  return match?.[1];
}

function parseVoiceSessionsByMid(sdp: string): Map<string, string> {
  const sessions = new Map<string, string>();
  for (const section of sdp.split(/(?=^m=)/m)) {
    const mid = /^a=mid:([^\r\n]+)$/m.exec(section)?.[1]?.trim();
    if (!mid) {
      continue;
    }
    for (const line of section.split(/\r?\n/)) {
      if (!line.includes("msid:")) {
        continue;
      }
      const trackId = line
        .slice(line.indexOf("msid:") + "msid:".length)
        .trim()
        .split(/\s+/)
        .findLast((field) => field.startsWith("voice_"));
      const sessionId = trackId ? parseVoiceTrackSessionId(trackId) : undefined;
      if (sessionId) {
        sessions.set(mid, sessionId);
        break;
      }
    }
  }
  return sessions;
}

function normalizeAudioData(data: MattermostCallsAudioData): Int16Array | undefined {
  const sampleRate = data.sampleRate ?? AUDIO_SAMPLE_RATE;
  const channelCount = data.channelCount ?? 1;
  if (sampleRate !== AUDIO_SAMPLE_RATE) {
    return undefined;
  }
  if (channelCount === AUDIO_CHANNELS) {
    return Int16Array.from(data.samples);
  }
  if (channelCount !== 1) {
    return undefined;
  }
  const stereo = new Int16Array(data.samples.length * 2);
  for (let index = 0; index < data.samples.length; index += 1) {
    const sample = data.samples[index] ?? 0;
    stereo[index * 2] = sample;
    stereo[index * 2 + 1] = sample;
  }
  return stereo;
}

function bufferToAudioSamples(frame: Buffer): Int16Array {
  const sampleCount = Math.floor(frame.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = frame.readInt16LE(index * 2);
  }
  return samples;
}

function buildCallsApiUrl(baseUrl: string, path: "config" | "turn-credentials"): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  return `${normalized}${CALLS_PLUGIN_API_PREFIX}/${path}`;
}

async function fetchCallsJson(params: {
  abortSignal?: AbortSignal;
  baseUrl: string;
  botToken: string;
  fetchImpl: MattermostFetch;
  path: "config" | "turn-credentials";
}): Promise<unknown> {
  const url = buildCallsApiUrl(params.baseUrl, params.path);
  const response = await params.fetchImpl(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.abortSignal,
  });
  if (!response.ok) {
    const detail = await readMattermostError(response);
    throw new Error(`Mattermost Calls ${params.path} failed (${response.status}): ${detail}`);
  }
  return await response.json();
}

async function resolveCallsIceServers(params: {
  abortSignal?: AbortSignal;
  baseUrl: string;
  botToken: string;
  fetchImpl: MattermostFetch;
}): Promise<MattermostCallsIceServer[]> {
  const config = CallsConfigSchema.parse(await fetchCallsJson({ ...params, path: "config" }));
  const iceServers = [...(config.ICEServersConfigs ?? [])];
  if (!config.NeedsTURNCredentials) {
    return iceServers;
  }
  const turnCredentials = TurnCredentialsSchema.parse(
    await fetchCallsJson({ ...params, path: "turn-credentials" }),
  );
  iceServers.push(...turnCredentials);
  return iceServers;
}

export async function connectMattermostCall(params: {
  baseUrl: string;
  wsUrl: string;
  botToken: string;
  channelId: string;
  callbacks: MattermostVoiceCallCallbacks;
  abortSignal?: AbortSignal;
  webSocketFactory?: (url: string) => MattermostCallsWebSocket;
  rtc?: MattermostCallsRtcFactory;
  fetchImpl?: MattermostFetch;
  decodeAudioFile?: (filePath: string) => Promise<Buffer>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onError?: (message: string) => void;
  onDebug?: (message: string) => void;
}): Promise<MattermostVoiceCallSession> {
  const rtc = params.rtc ?? defaultRtcFactory();
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? delay;
  const decode = params.decodeAudioFile ?? decodeAudioFileToStereo48k;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const iceServers = await resolveCallsIceServers({
    abortSignal: params.abortSignal,
    baseUrl: params.baseUrl,
    botToken: params.botToken,
    fetchImpl,
  });
  const ws = (params.webSocketFactory ?? defaultWebSocketFactory)(params.wsUrl);
  const sinksBySession = new Map<string, MattermostCallsAudioSink[]>();
  const pendingTracksByMid = new Map<string, unknown[]>();
  const pendingCandidates: IceCandidate[] = [];
  const voiceSessionsByMid = new Map<string, string>();
  let mediaMap: MattermostCallsMediaMap = {};
  let seq = 1;
  let closed = false;
  let connectionId: string | undefined;
  let joinedAt = 0;
  let peer: MattermostCallsPeerConnection | undefined;
  let audioSource: MattermostCallsAudioSource | undefined;
  let audioTrack: { stop?: () => void } | undefined;
  let remoteDescriptionReady = false;
  let sessionResolved = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let removeAbortListener: () => void = () => undefined;

  let resolveSession: (session: MattermostVoiceCallSession) => void = () => undefined;
  let rejectSession: (error: Error) => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const sessionPromise = new Promise<MattermostVoiceCallSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const reportError = (error: unknown) => {
    params.onError?.(`mattermost calls: ${String(error)}`);
  };
  const debug = (message: string) => {
    params.onDebug?.(`mattermost calls: ${message}`);
  };

  const send = (action: string, data: unknown, binary = false) => {
    if (closed) {
      return;
    }
    const envelope = { action, seq: seq++, data };
    ws.send(binary ? Buffer.from(encode(envelope)) : JSON.stringify(envelope));
  };

  const sendCalls = (action: string, data: unknown, binary = false) => {
    send(`${CALLS_PREFIX}${action}`, data, binary);
  };

  const sendDescription = (description: SessionDescription) => {
    // Calls requires zlib-compressed SDP inside a binary MessagePack envelope
    // so larger descriptions remain within its signaling wire contract.
    sendCalls("sdp", { data: deflateSync(JSON.stringify(description)) }, true);
  };

  const flushCandidates = async () => {
    if (!peer || !remoteDescriptionReady) {
      return;
    }
    for (const candidate of pendingCandidates.splice(0)) {
      await peer.addIceCandidate(candidate);
    }
  };

  const handleSignal = async (rawSignal: string) => {
    if (!peer) {
      return;
    }
    let signal: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawSignal);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      signal = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = readString(signal, "type");
    if (type === "offer" || type === "answer") {
      const sdp = readString(signal, "sdp");
      if (!sdp) {
        return;
      }
      for (const [mid, sessionId] of parseVoiceSessionsByMid(sdp)) {
        voiceSessionsByMid.set(mid, sessionId);
      }
      await peer.setRemoteDescription({ type, sdp });
      remoteDescriptionReady = true;
      await flushCandidates();
      if (type === "offer") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendDescription(answer);
      }
      return;
    }
    if (type !== "candidate") {
      return;
    }
    const candidateValue = signal.candidate;
    if (!candidateValue || typeof candidateValue !== "object" || Array.isArray(candidateValue)) {
      return;
    }
    const candidateRecord = candidateValue as Record<string, unknown>;
    const nestedCandidate = candidateRecord.candidate;
    const candidate =
      nestedCandidate && typeof nestedCandidate === "object" && !Array.isArray(nestedCandidate)
        ? (nestedCandidate as IceCandidate)
        : (candidateRecord as IceCandidate);
    if (remoteDescriptionReady) {
      await peer.addIceCandidate(candidate);
    } else {
      pendingCandidates.push(candidate);
    }
  };

  const stopSessionSinks = (sessionId: string) => {
    for (const sink of sinksBySession.get(sessionId) ?? []) {
      sink.stop();
    }
    sinksBySession.delete(sessionId);
  };

  const closeConnection = async (options: { sendLeave: boolean; closeSocket: boolean }) => {
    if (closed) {
      return;
    }
    removeAbortListener();
    if (options.sendLeave) {
      try {
        sendCalls("leave", null);
      } catch (error) {
        reportError(error);
      }
    }
    closed = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
    for (const sessionId of [...sinksBySession.keys()]) {
      stopSessionSinks(sessionId);
    }
    pendingTracksByMid.clear();
    audioTrack?.stop?.();
    peer?.close();
    if (options.closeSocket) {
      ws.close();
    }
    resolveClosed();
  };

  const close = async () => {
    await closeConnection({ sendLeave: true, closeSocket: true });
  };

  const play = async (audio: { audioPath: string }, options?: { signal?: AbortSignal }) => {
    const activeAudioSource = audioSource;
    if (closed || !activeAudioSource) {
      throw new Error("Mattermost call is not connected");
    }
    const isAborted = () => options?.signal?.aborted ?? false;
    if (isAborted()) {
      return;
    }
    const settleDelay = Math.max(0, joinedAt + CONNECTION_SETTLE_MILLISECONDS - now());
    // The SFU can acknowledge join before its outbound audio route is ready.
    // Holding first playback avoids clipping the beginning of the first reply.
    if (settleDelay > 0) {
      await sleep(settleDelay);
    }
    if (isAborted()) {
      return;
    }
    const pcm = await decode(audio.audioPath);
    if (isAborted()) {
      return;
    }
    sendCalls("unmute", null);
    await sleep(UNMUTE_SETTLE_MILLISECONDS);
    try {
      let targetTime = now();
      let sentPackets = 0;
      const writePacket = async (frame: Buffer) => {
        activeAudioSource.onData({
          samples: bufferToAudioSamples(frame),
          sampleRate: AUDIO_SAMPLE_RATE,
          bitsPerSample: 16,
          channelCount: AUDIO_CHANNELS,
          numberOfFrames: AUDIO_FRAMES_PER_PACKET,
        });
        sentPackets += 1;
        targetTime += AUDIO_FRAME_MILLISECONDS;
        const frameDelay = targetTime - now();
        if (frameDelay > 0) {
          await sleep(frameDelay);
        }
      };
      const silence = Buffer.alloc(AUDIO_BYTES_PER_PACKET);
      for (let index = 0; index < PLAYBACK_LEAD_IN_PACKETS; index += 1) {
        if (isAborted()) {
          return;
        }
        await writePacket(silence);
      }
      for (let offset = 0; offset < pcm.length; offset += AUDIO_BYTES_PER_PACKET) {
        if (isAborted()) {
          return;
        }
        const frame = Buffer.alloc(AUDIO_BYTES_PER_PACKET);
        pcm.copy(frame, 0, offset, Math.min(offset + AUDIO_BYTES_PER_PACKET, pcm.length));
        await writePacket(frame);
      }
      for (let index = 0; index < PLAYBACK_TRAILING_PACKETS; index += 1) {
        if (isAborted()) {
          return;
        }
        await writePacket(silence);
      }
      debug(`playback sent packets=${sentPackets} audioBytes=${pcm.length}`);
    } finally {
      sendCalls("mute", null);
    }
  };

  const initializePeer = () => {
    if (peer) {
      return;
    }
    peer = rtc.createPeerConnection({ iceServers });
    audioSource = rtc.createAudioSource();
    audioTrack = audioSource.createTrack();

    peer.on("icecandidate", (event: unknown) => {
      const candidate = (event as { candidate?: { toJSON?: () => IceCandidate } }).candidate;
      if (!candidate) {
        return;
      }
      const value = candidate.toJSON?.() ?? (candidate as IceCandidate);
      sendCalls("ice", { data: JSON.stringify(value) });
    });
    peer.on("negotiationneeded", async () => {
      try {
        if (!peer) {
          return;
        }
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        sendDescription(offer);
      } catch (error) {
        reportError(error);
      }
    });
    const audioStarted = new Set<string>();
    const attachTrack = (mid: string, track: unknown) => {
      const trackInfo = mediaMap[mid];
      if (trackInfo && trackInfo.type !== "voice") {
        return;
      }
      const trackId = (track as { id?: string }).id;
      const sessionId =
        voiceSessionsByMid.get(mid) ??
        (trackId ? parseVoiceTrackSessionId(trackId) : undefined) ??
        trackInfo?.sender_id;
      debug(
        `remote track mid=${mid} type=${trackInfo?.type ?? "unknown"} mapped=${Boolean(sessionId)}`,
      );
      if (!sessionId) {
        if (trackInfo) {
          return;
        }
        const pending = pendingTracksByMid.get(mid) ?? [];
        pending.push(track);
        pendingTracksByMid.set(mid, pending);
        return;
      }
      const sink = rtc.createAudioSink(track);
      const sessionSinks = sinksBySession.get(sessionId) ?? [];
      sessionSinks.push(sink);
      sinksBySession.set(sessionId, sessionSinks);
      sink.ondata = (data) => {
        const samples = normalizeAudioData(data);
        if (samples) {
          if (!audioStarted.has(sessionId)) {
            audioStarted.add(sessionId);
            debug(
              `audio started session=${sessionId} rate=${data.sampleRate ?? AUDIO_SAMPLE_RATE} channels=${data.channelCount ?? 1}`,
            );
          }
          params.callbacks.onAudio({ sessionId, samples });
        }
      };
    };

    peer.on("track", (event: unknown) => {
      const rtcEvent = event as {
        track?: unknown;
        transceiver?: { mid?: string | null };
      };
      const mid = rtcEvent.transceiver?.mid;
      if (!rtcEvent.track || !mid) {
        return;
      }
      attachTrack(mid, rtcEvent.track);
    });

    peer.addTrack(audioTrack);
    const dataChannel = peer.createDataChannel("calls-dc");
    dataChannel.binaryType = "arraybuffer";
    dataChannel.onopen = () => debug("data channel opened");
    dataChannel.onmessage = (event) => {
      try {
        const nextMediaMap = parseMediaMapMessage(event.data);
        if (!nextMediaMap) {
          return;
        }
        mediaMap = nextMediaMap;
        debug(`media map received entries=${Object.keys(mediaMap).length}`);
        for (const [mid, tracks] of pendingTracksByMid) {
          if (!mediaMap[mid]) {
            continue;
          }
          pendingTracksByMid.delete(mid);
          for (const track of tracks) {
            attachTrack(mid, track);
          }
        }
      } catch (error) {
        reportError(error);
      }
    };
  };

  const handleEvent = async (event: CallsEvent) => {
    const eventName = event.event;
    const eventConnectionId =
      readString(event.data, "connID") ?? readString(event.data, "connection_id");
    const isForeignConnectionEvent = Boolean(
      connectionId && eventConnectionId && eventConnectionId !== connectionId,
    );
    if (eventName === "hello") {
      connectionId = eventConnectionId;
      sendCalls("join", {
        channelID: params.channelId,
        jobID: "",
        av1Support: false,
        dcSignaling: false,
      });
      return;
    }
    if (eventName === `${CALLS_PREFIX}join`) {
      if (isForeignConnectionEvent) {
        return;
      }
      initializePeer();
      joinedAt = now();
      debug("join acknowledged");
      sessionResolved = true;
      resolveSession({ play, close, closed: closedPromise });
      return;
    }
    if (eventName === `${CALLS_PREFIX}signal`) {
      if (isForeignConnectionEvent) {
        return;
      }
      const signal = readString(event.data, "data");
      if (signal) {
        await handleSignal(signal);
      }
      return;
    }
    if (
      eventName === `${CALLS_PREFIX}user_voice_on` ||
      eventName === `${CALLS_PREFIX}user_voice_off`
    ) {
      const sessionId = readString(event.data, "session_id");
      const userId = readString(event.data, "userID") ?? readString(event.data, "user_id");
      if (sessionId && userId) {
        debug(`voice ${eventName.endsWith("_on") ? "on" : "off"} session=${sessionId}`);
        params.callbacks.onVoice({
          sessionId,
          userId,
          speaking: eventName.endsWith("_on"),
        });
      }
      return;
    }
    if (eventName === `${CALLS_PREFIX}user_left`) {
      const sessionId = readString(event.data, "session_id");
      if (sessionId) {
        stopSessionSinks(sessionId);
      }
      return;
    }
    if (eventName === `${CALLS_PREFIX}call_end`) {
      const channelId =
        readString(event.data, "channelID") ?? readString(event.broadcast, "channel_id");
      if (channelId === params.channelId) {
        await close();
      }
    }
  };

  ws.on("open", () => {
    send("authentication_challenge", { token: params.botToken });
    pingTimer = setInterval(() => {
      try {
        ws.ping();
      } catch (error) {
        reportError(error);
      }
    }, PING_INTERVAL_MILLISECONDS);
    pingTimer.unref();
  });
  ws.on("message", async (data: unknown) => {
    const event = parseEvent(data);
    if (!event) {
      return;
    }
    try {
      await handleEvent(event);
    } catch (error) {
      reportError(error);
      rejectSession(error instanceof Error ? error : new Error(String(error)));
    }
  });
  ws.on("error", (error: unknown) => {
    reportError(error);
    rejectSession(error instanceof Error ? error : new Error(String(error)));
  });
  ws.on("close", async () => {
    await closeConnection({ sendLeave: false, closeSocket: false });
    if (!sessionResolved) {
      rejectSession(new Error("Mattermost Calls WebSocket closed before joining"));
    }
  });

  const onAbort = () => {
    rejectSession(new Error("Mattermost call stopped during gateway shutdown"));
    void close();
  };
  if (params.abortSignal?.aborted) {
    onAbort();
  } else if (params.abortSignal) {
    params.abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => params.abortSignal?.removeEventListener("abort", onAbort);
  }

  return await sessionPromise;
}
