/**
 * Media Stream Handler
 *
 * Handles bidirectional audio streaming between telephony providers and AI services.
 * Supports both Twilio and Telnyx WebSocket media stream formats.
 * - Receives mu-law audio from provider via WebSocket
 * - Forwards to STT provider (OpenAI Realtime, Deepgram, etc.) for transcription
 * - Sends TTS audio back to provider
 */

import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { G722Decoder } from "./g722-decoder.js";

const STREAM_DEBUG_LOG = path.join(os.homedir(), ".openclaw", "voice-debug.log");
function streamDebug(msg: string): void {
  const line = `[${new Date().toISOString()}] [MediaStream] ${msg}\n`;
  try { fs.appendFileSync(STREAM_DEBUG_LOG, line); } catch { /* ignore */ }
}
import type {
  STTProvider,
  RealtimeSTTSession,
} from "./providers/stt-openai-realtime.js";

/**
 * Configuration for the media stream handler.
 */
export interface MediaStreamConfig {
  /** STT provider for transcription (OpenAI Realtime, Deepgram, etc.) */
  sttProvider: STTProvider;
  /** Close sockets that never send a valid `start` frame within this window. */
  preStartTimeoutMs?: number;
  /** Max concurrent pre-start sockets. */
  maxPendingConnections?: number;
  /** Max concurrent pre-start sockets from a single source IP. */
  maxPendingConnectionsPerIp?: number;
  /** Max total open sockets (pending + active sessions). */
  maxConnections?: number;
  /** Validate whether to accept a media stream for the given call ID */
  shouldAcceptStream?: (params: { callId: string; streamSid: string; token?: string }) => boolean;
  /** Callback when transcript is received */
  onTranscript?: (callId: string, transcript: string) => void;
  /** Callback for partial transcripts (streaming UI) */
  onPartialTranscript?: (callId: string, partial: string) => void;
  /** Callback when stream connects */
  onConnect?: (callId: string, streamSid: string) => void;
  /** Callback when speech starts (barge-in) */
  onSpeechStart?: (callId: string) => void;
  /** Callback when stream disconnects */
  onDisconnect?: (callId: string) => void;
}

/**
 * Active media stream session.
 */
interface StreamSession {
  callId: string;
  streamSid: string;
  ws: WebSocket;
  sttSession: RealtimeSTTSession;
  _mediaCount?: number;
  /** G722 decoder instance — set when Telnyx sends G722 encoded audio */
  g722Decoder?: G722Decoder;
}

type TtsQueueEntry = {
  playFn: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingConnection = {
  ip: string;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_PRE_START_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PENDING_CONNECTIONS = 32;
const DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP = 4;
const DEFAULT_MAX_CONNECTIONS = 128;

/**
 * Manages WebSocket connections for telephony media streams (Twilio and Telnyx).
 */
export class MediaStreamHandler {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, StreamSession>();
  private config: MediaStreamConfig;
  /** Pending sockets that have upgraded but not yet sent an accepted `start` frame. */
  private pendingConnections = new Map<WebSocket, PendingConnection>();
  /** Pending socket count per remote IP for pre-auth throttling. */
  private pendingByIp = new Map<string, number>();
  private preStartTimeoutMs: number;
  private maxPendingConnections: number;
  private maxPendingConnectionsPerIp: number;
  private maxConnections: number;
  /** TTS playback queues per stream (serialize audio to prevent overlap) */
  private ttsQueues = new Map<string, TtsQueueEntry[]>();
  /** Whether TTS is currently playing per stream */
  private ttsPlaying = new Map<string, boolean>();
  /** Active TTS playback controllers per stream */
  private ttsActiveControllers = new Map<string, AbortController>();

  constructor(config: MediaStreamConfig) {
    this.config = config;
    this.preStartTimeoutMs = config.preStartTimeoutMs ?? DEFAULT_PRE_START_TIMEOUT_MS;
    this.maxPendingConnections = config.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS;
    this.maxPendingConnectionsPerIp =
      config.maxPendingConnectionsPerIp ?? DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP;
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  }

  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    streamDebug(`WebSocket upgrade request: ${request.url} from ${request.socket.remoteAddress}`);
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    }

    const currentConnections = this.wss.clients.size;
    if (currentConnections >= this.maxConnections) {
      streamDebug(`Rejecting upgrade: too many connections (${currentConnections}/${this.maxConnections})`);
      this.rejectUpgrade(socket, 503, "Too many media stream connections");
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      streamDebug(`WebSocket upgrade completed successfully`);
      this.wss?.emit("connection", ws, request);
    });
  }

  /**
   * Handle new WebSocket connection from telephony provider (Twilio or Telnyx).
   */
  private async handleConnection(ws: WebSocket, _request: IncomingMessage): Promise<void> {
    let session: StreamSession | null = null;
    const streamToken = this.getStreamToken(_request);
    const ip = this.getClientIp(_request);

    if (!this.registerPendingConnection(ws, ip)) {
      ws.close(1013, "Too many pending media stream connections");
      return;
    }

    ws.on("message", async (data: Buffer) => {
      try {
        const raw = JSON.parse(data.toString());
        const message = this.normalizeMediaMessage(raw);

        switch (message.event) {
          case "connected":
            streamDebug(`Provider connected (streamSid=${message.streamSid})`);
            break;

          case "start": {
            const callId = message.start?.callSid || "unknown";
            const mf = raw.start?.media_format || raw.start?.mediaFormat;
            streamDebug(`Start event: callSid=${callId} streamSid=${message.streamSid} media_format=${JSON.stringify(mf)} raw_keys=${Object.keys(raw.start || {}).join(",")}`);
            session = await this.handleStart(ws, message, streamToken);
            if (session) {
              streamDebug(`Session created: callId=${session.callId} streamSid=${session.streamSid}`);
              this.clearPendingConnection(ws);
            } else {
              streamDebug(`Session creation FAILED for callSid=${callId}`);
            }
            break;
          }

          case "media":
            if (session && message.media?.payload) {
              // Forward audio to STT (transcode G722 → linear16 if needed)
              const rawAudio = Buffer.from(message.media.payload, "base64");
              const audioBuffer = session.g722Decoder
                ? session.g722Decoder.decode(rawAudio)
                : rawAudio;
              session.sttSession.sendAudio(audioBuffer);
              // Diagnostic: log every 100th media frame to confirm audio flow
              if (!session._mediaCount) session._mediaCount = 0;
              session._mediaCount++;
              if (session._mediaCount % 100 === 1) {
                streamDebug(`Media frame #${session._mediaCount}: ${rawAudio.length} bytes${session.g722Decoder ? ` → ${audioBuffer.length} bytes PCM16` : ""}, STT connected=${session.sttSession.isConnected?.() ?? "?"}`);
              }
            }
            break;

          case "stop":
            streamDebug(`Stop event: streamSid=${message.streamSid}`);
            if (session) {
              this.handleStop(session);
              session = null;
            }
            break;

          default:
            streamDebug(`Unknown event: ${message.event} raw=${JSON.stringify(raw).slice(0, 200)}`);
            break;
        }
      } catch (error) {
        streamDebug(`Error processing message: ${error}`);
        console.error("[MediaStream] Error processing message:", error);
      }
    });

    ws.on("close", () => {
      this.clearPendingConnection(ws);
      if (session) {
        this.handleStop(session);
      }
    });

    ws.on("error", (error) => {
      console.error("[MediaStream] WebSocket error:", error);
    });
  }

  /**
   * Handle stream start event.
   */
  private async handleStart(
    ws: WebSocket,
    message: MediaStreamMessage,
    streamToken?: string,
  ): Promise<StreamSession | null> {
    const streamSid = message.streamSid || "";
    const callSid = message.start?.callSid || "";

    // Prefer token from start message customParameters (set via TwiML <Parameter>),
    // falling back to query string token. Twilio strips query params from WebSocket
    // URLs but reliably delivers <Parameter> values in customParameters.
    const effectiveToken = message.start?.customParameters?.token ?? streamToken;

    streamDebug(`handleStart: streamSid=${streamSid} callSid=${callSid} token=${effectiveToken || "none"}`);
    if (!callSid) {
      streamDebug(`REJECTED: Missing callSid`);
      ws.close(1008, "Missing callSid");
      return null;
    }
    if (
      this.config.shouldAcceptStream &&
      !this.config.shouldAcceptStream({ callId: callSid, streamSid, token: effectiveToken })
    ) {
      streamDebug(`REJECTED: shouldAcceptStream returned false for callSid=${callSid}`);
      ws.close(1008, "Unknown call");
      return null;
    }

    // Create STT session
    const sttSession = this.config.sttProvider.createSession();

    // Set up transcript callbacks
    sttSession.onPartial((partial) => {
      this.config.onPartialTranscript?.(callSid, partial);
    });

    sttSession.onTranscript((transcript) => {
      this.config.onTranscript?.(callSid, transcript);
    });

    sttSession.onSpeechStart(() => {
      this.config.onSpeechStart?.(callSid);
    });

    // Detect G722 encoding from Telnyx media format and set up decoder
    const encoding = message.start?.mediaFormat?.encoding?.toUpperCase() || "";
    const isG722 = encoding === "G722" || encoding === "G.722";
    if (isG722) {
      streamDebug(`G722 audio detected — enabling real-time transcoding to linear16 @ 16kHz`);
    }

    const session: StreamSession = {
      callId: callSid,
      streamSid,
      ws,
      sttSession,
      g722Decoder: isG722 ? new G722Decoder() : undefined,
    };

    this.sessions.set(streamSid, session);

    // Notify connection BEFORE STT connect so TTS can work even if STT fails
    this.config.onConnect?.(callSid, streamSid);

    // Connect to STT (non-blocking, log errors but don't fail the call)
    sttSession.connect().catch((err) => {
      console.warn(`[MediaStream] STT connection failed (TTS still works):`, err.message);
    });

    return session;
  }

  /**
   * Handle stream stop event.
   */
  private handleStop(session: StreamSession): void {
    console.log(`[MediaStream] Stream stopped: ${session.streamSid}`);

    this.clearTtsState(session.streamSid);
    session.sttSession.close();
    this.sessions.delete(session.streamSid);
    this.config.onDisconnect?.(session.callId);
  }

  /**
   * Normalize incoming WebSocket messages from either Twilio or Telnyx format
   * into a common MediaStreamMessage shape.
   *
   * Telnyx differences:
   *  - Uses `stream_id` instead of `streamSid`
   *  - Uses `start.call_control_id` instead of `start.callSid`
   *  - Uses `start.media_format` instead of `start.mediaFormat`
   *  - May skip the `connected` event entirely
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizeMediaMessage(raw: any): MediaStreamMessage {
    // Normalize stream ID: Telnyx uses stream_id, Twilio uses streamSid
    const streamSid = raw.streamSid ?? raw.stream_id ?? "";

    const message: MediaStreamMessage = {
      event: raw.event,
      sequenceNumber: raw.sequenceNumber ?? raw.sequence_number,
      streamSid,
    };

    if (raw.start) {
      message.start = {
        streamSid: raw.start.streamSid ?? raw.stream_id ?? streamSid,
        // Telnyx: call_control_id; Twilio: callSid
        callSid: raw.start.callSid ?? raw.start.call_control_id ?? "",
        accountSid: raw.start.accountSid ?? raw.start.user_id ?? "",
        tracks: raw.start.tracks ?? [],
        customParameters: raw.start.customParameters ?? {},
        mediaFormat: raw.start.mediaFormat ?? raw.start.media_format ?? {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          channels: 1,
        },
      };
      // Telnyx may encode callId in client_state (base64)
      if (!message.start.callSid && raw.start.client_state) {
        try {
          message.start.callSid = Buffer.from(raw.start.client_state, "base64").toString("utf-8");
        } catch { /* ignore decode errors */ }
      }
    }

    if (raw.media) {
      message.media = {
        track: raw.media.track,
        chunk: raw.media.chunk,
        timestamp: raw.media.timestamp,
        payload: raw.media.payload,
      };
    }

    if (raw.mark) {
      message.mark = { name: raw.mark.name };
    }

    return message;
  }

  private getStreamToken(request: IncomingMessage): string | undefined {
    if (!request.url || !request.headers.host) {
      return undefined;
    }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      return url.searchParams.get("token") ?? undefined;
    } catch {
      return undefined;
    }
  }

  private getClientIp(request: IncomingMessage): string {
    return request.socket.remoteAddress || "unknown";
  }

  private registerPendingConnection(ws: WebSocket, ip: string): boolean {
    if (this.pendingConnections.size >= this.maxPendingConnections) {
      console.warn("[MediaStream] Rejecting connection: pending connection limit reached");
      return false;
    }

    const pendingForIp = this.pendingByIp.get(ip) ?? 0;
    if (pendingForIp >= this.maxPendingConnectionsPerIp) {
      console.warn(`[MediaStream] Rejecting connection: pending per-IP limit reached (${ip})`);
      return false;
    }

    const timeout = setTimeout(() => {
      if (!this.pendingConnections.has(ws)) {
        return;
      }
      console.warn(
        `[MediaStream] Closing pre-start idle connection after ${this.preStartTimeoutMs}ms (${ip})`,
      );
      ws.close(1008, "Start timeout");
    }, this.preStartTimeoutMs);

    timeout.unref?.();
    this.pendingConnections.set(ws, { ip, timeout });
    this.pendingByIp.set(ip, pendingForIp + 1);
    return true;
  }

  private clearPendingConnection(ws: WebSocket): void {
    const pending = this.pendingConnections.get(ws);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingConnections.delete(ws);

    const current = this.pendingByIp.get(pending.ip) ?? 0;
    if (current <= 1) {
      this.pendingByIp.delete(pending.ip);
      return;
    }
    this.pendingByIp.set(pending.ip, current - 1);
  }

  private rejectUpgrade(socket: Duplex, statusCode: 429 | 503, message: string): void {
    const statusText = statusCode === 429 ? "Too Many Requests" : "Service Unavailable";
    const body = `${message}\n`;
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
    socket.destroy();
  }

  /**
   * Get an active session with an open WebSocket, or undefined if unavailable.
   */
  private getOpenSession(streamSid: string): StreamSession | undefined {
    const session = this.sessions.get(streamSid);
    return session?.ws.readyState === WebSocket.OPEN ? session : undefined;
  }

  /**
   * Send a message to a stream's WebSocket if available.
   */
  private sendToStream(streamSid: string, message: unknown): void {
    const session = this.getOpenSession(streamSid);
    session?.ws.send(JSON.stringify(message));
  }

  /**
   * Send audio to a specific stream (for TTS playback).
   * Audio should be mu-law encoded at 8kHz mono.
   */
  sendAudio(streamSid: string, muLawAudio: Buffer): void {
    this.sendToStream(streamSid, {
      event: "media",
      streamSid,
      media: { payload: muLawAudio.toString("base64") },
    });
  }

  /**
   * Send a mark event to track audio playback position.
   */
  sendMark(streamSid: string, name: string): void {
    this.sendToStream(streamSid, {
      event: "mark",
      streamSid,
      mark: { name },
    });
  }

  /**
   * Clear audio buffer (interrupt playback).
   */
  clearAudio(streamSid: string): void {
    this.sendToStream(streamSid, { event: "clear", streamSid });
  }

  /**
   * Queue a TTS operation for sequential playback.
   * Only one TTS operation plays at a time per stream to prevent overlap.
   */
  async queueTts(streamSid: string, playFn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const queue = this.getTtsQueue(streamSid);
    let resolveEntry: () => void;
    let rejectEntry: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });

    queue.push({
      playFn,
      controller: new AbortController(),
      resolve: resolveEntry!,
      reject: rejectEntry!,
    });

    if (!this.ttsPlaying.get(streamSid)) {
      void this.processQueue(streamSid);
    }

    return promise;
  }

  /**
   * Clear TTS queue and interrupt current playback (barge-in).
   */
  clearTtsQueue(streamSid: string): void {
    const queue = this.getTtsQueue(streamSid);
    queue.length = 0;
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.clearAudio(streamSid);
  }

  /**
   * Get active session by call ID.
   */
  getSessionByCallId(callId: string): StreamSession | undefined {
    return [...this.sessions.values()].find((session) => session.callId === callId);
  }

  /**
   * Close all sessions.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      this.clearTtsState(session.streamSid);
      session.sttSession.close();
      session.ws.close();
    }
    this.sessions.clear();
  }

  private getTtsQueue(streamSid: string): TtsQueueEntry[] {
    const existing = this.ttsQueues.get(streamSid);
    if (existing) {
      return existing;
    }
    const queue: TtsQueueEntry[] = [];
    this.ttsQueues.set(streamSid, queue);
    return queue;
  }

  /**
   * Process the TTS queue for a stream.
   * Uses iterative approach to avoid stack accumulation from recursion.
   */
  private async processQueue(streamSid: string): Promise<void> {
    this.ttsPlaying.set(streamSid, true);

    while (true) {
      const queue = this.ttsQueues.get(streamSid);
      if (!queue || queue.length === 0) {
        this.ttsPlaying.set(streamSid, false);
        this.ttsActiveControllers.delete(streamSid);
        return;
      }

      const entry = queue.shift()!;
      this.ttsActiveControllers.set(streamSid, entry.controller);

      try {
        await entry.playFn(entry.controller.signal);
        entry.resolve();
      } catch (error) {
        if (entry.controller.signal.aborted) {
          entry.resolve();
        } else {
          console.error("[MediaStream] TTS playback error:", error);
          entry.reject(error);
        }
      } finally {
        if (this.ttsActiveControllers.get(streamSid) === entry.controller) {
          this.ttsActiveControllers.delete(streamSid);
        }
      }
    }
  }

  private clearTtsState(streamSid: string): void {
    const queue = this.ttsQueues.get(streamSid);
    if (queue) {
      queue.length = 0;
    }
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.ttsActiveControllers.delete(streamSid);
    this.ttsPlaying.delete(streamSid);
    this.ttsQueues.delete(streamSid);
  }
}

/**
 * Normalized media stream message format (supports both Twilio and Telnyx).
 */
interface MediaStreamMessage {
  event: "connected" | "start" | "media" | "stop" | "mark" | "clear";
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters?: Record<string, string>;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    payload?: string;
  };
  mark?: {
    name: string;
  };
}
