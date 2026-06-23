/**
 * MsteamsMediaStream
 *
 * WebSocket server that accepts connections from an external Windows-side Teams
 * bridge worker and relays Microsoft Teams call audio in both directions. One
 * connection per Teams call, keyed by callId in the URL path.
 *
 * Responsibilities:
 * - HTTP upgrade with HMAC-SHA256 verification of timestamp + callId, plus a
 *   replay window on the timestamp.
 * - Session lifecycle messages (session.start / session.end) parsed and emitted
 *   via callbacks for the host to wire into voice-call's session machinery.
 * - Inbound audio frames surfaced via `onAudioFrame` for the host to forward to
 *   the realtime-transcription provider.
 * - Outbound `send` and `close` exposed on the SessionStart callback so the host
 *   can push synthesized TTS audio and control messages back to the worker.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

/**
 * The Teams bridge wire format is PCM 16 kHz, 16-bit, mono in both directions. Single source of
 * truth for the sample rate shared by the provider, realtime bridge, and TTS adapter.
 */
export const MSTEAMS_PCM_SAMPLE_RATE_HZ = 16_000;

const RecordingStatusSchema = z.enum(["active", "inactive", "unknown"]);

const SessionStartSchema = z.object({
  type: z.literal("session.start"),
  callId: z.string().min(1),
  threadId: z.string().min(1),
  caller: z.object({
    aadId: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    tenantId: z.string().nullable().optional(),
  }),
  /**
   * Microsoft Teams recording status at answer time. The worker must call Graph
   * `updateRecordingStatus` before media-derived data may be persisted; it
   * reports the resulting state here (and via `recording.status` if it changes).
   */
  recordingStatus: RecordingStatusSchema.optional(),
  /**
   * "inbound" (caller dialed the bot) or "outbound" (the bot placed this call via
   * the worker's /api/calls). OpenClaw correlates outbound calls by callId regardless,
   * but this makes the media-plane self-describing. Defaults to inbound when absent.
   */
  direction: z.enum(["inbound", "outbound"]).optional(),
});

const SessionEndSchema = z.object({
  type: z.literal("session.end"),
  reason: z.string(),
});

const RecordingStatusMessageSchema = z.object({
  type: z.literal("recording.status"),
  status: RecordingStatusSchema,
});

const AudioFrameSchema = z.object({
  type: z.literal("audio.frame"),
  seq: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative(),
  payloadBase64: z.string(),
  // Active speaker's display name when the worker runs unmixed meeting audio (additive) —
  // real per-person transcript attribution for meeting minutes.
  speakerName: z.string().optional(),
});

const PingSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().int().nonnegative(),
});

/**
 * A sampled inbound video frame (caller camera or screen-share) the worker forwards so the agent
 * can "see" what the caller shows it. Sparse (a frame every few seconds), JPEG, already downscaled
 * worker-side. Much larger than audio — see the inbound payload cap.
 */
const VideoFrameSchema = z.object({
  type: z.literal("video.frame"),
  source: z.enum(["camera", "screenshare"]),
  ts: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.string().min(1),
  dataBase64: z.string().min(1),
  // Who this frame belongs to (group calls): the subscribed speaker for "camera", the sharer for
  // "screenshare". Best-effort — absent for anonymous/guest participants or older workers.
  participantId: z.string().min(1).optional(),
  participantName: z.string().min(1).optional(),
});

/**
 * Worker → OpenClaw. The human participant count on the call (excludes the bot), sent at join and
 * whenever the roster changes. Lets OpenClaw tell a 1:1 call (count <= 1) from a group/meeting call
 * (count >= 2) so it can apply the "speak only when addressed" gate in groups.
 */
const ParticipantsSchema = z.object({
  type: z.literal("participants"),
  count: z.number().int().nonnegative(),
});

/** Worker → OpenClaw: a DTMF key the caller pressed ("0"-"9", "*", "#"). See #21. */
const DtmfSchema = z.object({
  type: z.literal("dtmf"),
  digit: z.string().min(1).max(1),
});

const InboundMessageSchema = z.discriminatedUnion("type", [
  SessionStartSchema,
  SessionEndSchema,
  RecordingStatusMessageSchema,
  AudioFrameSchema,
  VideoFrameSchema,
  ParticipantsSchema,
  DtmfSchema,
  PingSchema,
]);

export type MsteamsRecordingStatus = z.infer<typeof RecordingStatusSchema>;

type InboundMessage = z.infer<typeof InboundMessageSchema>;

export interface MsteamsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface MsteamsSession {
  callId: string;
  threadId: string;
  caller: {
    aadId?: string | null;
    displayName?: string | null;
    tenantId?: string | null;
  };
  /** Teams recording status reported at answer time (if the worker set it). */
  recordingStatus?: MsteamsRecordingStatus;
  /** "inbound" (default) or "outbound" (the bot placed this call). */
  direction?: "inbound" | "outbound";
  /**
   * Push a JSON-serializable message to the worker. Returns false if the socket is closed/missing
   * (the message was dropped) so delivery-sensitive callers (audio frames) can observe the drop;
   * best-effort control frames can ignore the result.
   */
  send: (message: unknown) => boolean;
  /** Close the WebSocket gracefully with the given reason text. */
  close: (reason: string) => void;
}

export interface MsteamsMediaStreamConfig {
  port: number;
  /**
   * Interface address to bind the WebSocket server to. Defaults to the loopback
   * interface (127.0.0.1) so the bridge is not exposed on all interfaces.
   */
  bindAddress?: string;
  path: string;
  sharedSecret: string;
  /**
   * Reject upgrades whose timestamp is more than this many ms off from the
   * server clock. Mitigates replay. Default 60_000 (60 seconds).
   */
  hmacWindowMs?: number;
  /** Hard cap on total concurrent connections (pending + active). Default 64. */
  maxConnections?: number;
  /** Hard cap on concurrent connections per source IP. Default 8. */
  maxConnectionsPerIp?: number;
  /** Close a connection that has not sent session.start within this many ms. Default 10_000. */
  preStartTimeoutMs?: number;
  logger?: MsteamsLogger;
  onSessionStart?: (session: MsteamsSession) => void;
  /** Teams recording status changed mid-call (worker called Graph updateRecordingStatus). */
  onRecordingStatus?: (info: { callId: string; status: MsteamsRecordingStatus }) => void;
  onSessionEnd?: (info: { callId: string; reason: string }) => void;
  onAudioFrame?: (info: {
    callId: string;
    seq: number;
    timestampMs: number;
    payload: Buffer;
    /** Active speaker (unmixed-audio worker), for transcript attribution. */
    speakerName?: string;
  }) => void;
  /** A sampled inbound video frame (caller camera or screen-share) for the agent to "see". */
  onVideoFrame?: (info: {
    callId: string;
    source: "camera" | "screenshare";
    ts: number;
    width: number;
    height: number;
    mime: string;
    dataBase64: string;
    participantId?: string;
    participantName?: string;
  }) => void;
  /** Human participant count on the call changed (excludes the bot). count >= 2 ⇒ group/meeting. */
  onParticipants?: (info: { callId: string; count: number }) => void;
  /** A DTMF key the caller pressed ("0"-"9", "*", "#"). See #21. */
  onDtmf?: (info: { callId: string; digit: string }) => void;
}

const DEFAULT_HMAC_WINDOW_MS = 60_000;

/**
 * Bind to loopback by default. The Teams bridge worker typically runs on the
 * same host (or reaches OpenClaw over a private/VPN interface the operator names
 * explicitly via `bindAddress`); binding all interfaces would expose the audio
 * transport to untrusted networks.
 */
const DEFAULT_BIND_ADDRESS = "127.0.0.1";

/**
 * Hard cap on a single inbound WebSocket frame. Control + audio messages are tiny
 * (<1 KB), but a `video.frame` carries a base64 JPEG (the worker downscales and caps
 * the JPEG at ~1 MB, so base64 ≈ 1.4 MB). The cap is sized to admit one such frame
 * and still bound memory: the sender is the HMAC-authenticated worker, not an
 * arbitrary peer, so the looser bound only loosens the trusted path.
 */
const MAX_INBOUND_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Connection guardrails, mirroring the Twilio media-stream path so a valid
 * shared secret (or a leaked/misbehaving worker) cannot open call sockets
 * unbounded and exhaust file descriptors or memory.
 */
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 8;
const DEFAULT_PRE_START_TIMEOUT_MS = 10_000;

/** Per-connection bookkeeping for caps + pre-start idle reaping. */
interface ConnectionMeta {
  ip: string;
  started: boolean;
  /** Set once onSessionEnd has fired, so socket close does not double-deliver it. */
  ended: boolean;
  preStartTimer: ReturnType<typeof setTimeout>;
}

export class MsteamsMediaStream {
  private readonly config: MsteamsMediaStreamConfig;
  private readonly hmacWindowMs: number;
  /** Verified upgrade tuples already used once (replay guard); value = expiry epoch ms. */
  private readonly seenUpgrades = new Map<string, number>();
  private readonly maxConnections: number;
  private readonly maxConnectionsPerIp: number;
  private readonly preStartTimeoutMs: number;
  private readonly sessions = new Map<string, WebSocket>();
  private readonly connectionMeta = new Map<string, ConnectionMeta>();
  private readonly connectionsByIp = new Map<string, number>();
  private server?: http.Server;
  private wss?: WebSocketServer;

  constructor(config: MsteamsMediaStreamConfig) {
    this.config = config;
    this.hmacWindowMs = config.hmacWindowMs ?? DEFAULT_HMAC_WINDOW_MS;
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxConnectionsPerIp = config.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
    this.preStartTimeoutMs = config.preStartTimeoutMs ?? DEFAULT_PRE_START_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("MsteamsMediaStream is already started");
    }

    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });

    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head, wss);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.port, this.config.bindAddress ?? DEFAULT_BIND_ADDRESS);
    });

    this.server = server;
    this.wss = wss;
    this.config.logger?.info(
      `MsteamsMediaStream listening host=${this.config.bindAddress ?? DEFAULT_BIND_ADDRESS} port=${this.config.port} path=${this.config.path}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const ws of this.sessions.values()) {
      try {
        ws.close(1001, "shutdown");
      } catch {
        // best-effort close
      }
    }
    for (const meta of this.connectionMeta.values()) {
      clearTimeout(meta.preStartTimer);
    }
    this.connectionMeta.clear();
    this.connectionsByIp.clear();
    this.sessions.clear();

    this.wss?.close();
    await new Promise<void>((resolve) => {
      // server is non-null because we early-returned above; cast is for ts narrowing
      const s = this.server as http.Server;
      s.close(() => resolve());
    });

    this.server = undefined;
    this.wss = undefined;
    this.config.logger?.info("MsteamsMediaStream stopped");
  }

  /** Number of currently open sessions. Exposed for tests + telemetry. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ): void {
    const url = new URL(request.url ?? "", "http://localhost");

    if (!url.pathname.startsWith(this.config.path)) {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const callId = url.pathname.slice(this.config.path.length).replace(/^\//, "");
    if (!callId) {
      this.rejectUpgrade(socket, 400, "Bad Request (missing callId)");
      return;
    }

    const timestamp = request.headers["x-openclawteamsbridge-timestamp"];
    const signature = request.headers["x-openclawteamsbridge-signature"];
    if (typeof timestamp !== "string" || typeof signature !== "string") {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — missing HMAC headers`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.hmacWindowMs) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — timestamp out of window`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const expected = crypto
      .createHmac("sha256", this.config.sharedSecret)
      .update(`${ts}.${callId}`)
      .digest("hex");
    if (!safeEqualSecret(signature, expected)) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — bad signature`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    // Replay guard: a verified (callId, timestamp, signature) tuple is single-use. A captured
    // handshake replayed within the HMAC window would otherwise open a ghost session once the live
    // call ends (the duplicate-callId check only protects while it's connected). A legitimate
    // reconnect always carries a fresh timestamp, so this rejects only true replays. Only verified
    // tuples are recorded (an attacker without the secret cannot grow the map); entries expire with
    // the timestamp window.
    const now = Date.now();
    for (const [key, expiry] of this.seenUpgrades) {
      if (expiry <= now) {
        this.seenUpgrades.delete(key);
      }
    }
    const replayKey = `${callId}.${ts}.${signature}`;
    if (this.seenUpgrades.has(replayKey)) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — replayed handshake`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    // Expire the replay record when the TIMESTAMP stops being valid (ts + window), not at now +
    // window. A future-dated handshake (worker clock skew) is signature-valid until ts + window; a
    // record swept at now + window would leave it replayable in between.
    this.seenUpgrades.set(replayKey, ts + this.hmacWindowMs);

    const ip = normalizeIp(request.socket.remoteAddress);
    // Bound total + per-IP concurrent sockets before accepting the upgrade.
    if (this.sessions.size >= this.maxConnections) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting ${callId} — max connections (${this.maxConnections}) reached`,
      );
      this.rejectUpgrade(socket, 503, "Too Many Connections");
      return;
    }
    if ((this.connectionsByIp.get(ip) ?? 0) >= this.maxConnectionsPerIp) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting ${callId} — per-IP cap (${this.maxConnectionsPerIp}) reached for ${ip}`,
      );
      this.rejectUpgrade(socket, 503, "Too Many Connections");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      this.attachSession(callId, ws, ip);
    });
  }

  private attachSession(callId: string, ws: WebSocket, ip: string): void {
    if (this.sessions.has(callId)) {
      // Same callId already connected — close the new one to avoid clobbering.
      try {
        ws.close(1008, "duplicate-callId");
      } catch {
        // ignore
      }
      this.config.logger?.warn(`MsteamsMediaStream: rejected duplicate connection for ${callId}`);
      return;
    }

    this.sessions.set(callId, ws);
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) ?? 0) + 1);
    // Reap sockets that authenticate but never send session.start (idle hold).
    const preStartTimer = setTimeout(() => {
      this.config.logger?.warn(
        `MsteamsMediaStream: closing ${callId} — no session.start within ${this.preStartTimeoutMs}ms`,
      );
      this.closeSession(callId, "pre-start-timeout");
    }, this.preStartTimeoutMs);
    if (typeof preStartTimer.unref === "function") {
      preStartTimer.unref();
    }
    this.connectionMeta.set(callId, { ip, started: false, ended: false, preStartTimer });
    this.config.logger?.info(`MsteamsMediaStream: connection open ${callId}`);

    ws.on("message", (data) => this.handleMessage(callId, data));
    ws.on("close", () => {
      // An abrupt socket close (worker crash, network loss, hangup without a
      // session.end frame) must still tear down provider + manager state for a
      // session that already started — otherwise the call record leaks until the
      // stale-call reaper. The `ended` guard avoids double-delivery when the
      // close follows an explicit session.end.
      const meta = this.connectionMeta.get(callId);
      if (meta?.started && !meta.ended) {
        meta.ended = true;
        this.config.onSessionEnd?.({ callId, reason: "socket-closed" });
      }
      this.cleanupConnection(callId);
      this.config.logger?.info(`MsteamsMediaStream: connection closed ${callId}`);
    });
    ws.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.config.logger?.warn(`MsteamsMediaStream: ws error ${callId} — ${message}`);
    });
  }

  /** Release per-connection tracking (timer, per-IP count, session entry). */
  private cleanupConnection(callId: string): void {
    const meta = this.connectionMeta.get(callId);
    if (meta) {
      clearTimeout(meta.preStartTimer);
      const remaining = (this.connectionsByIp.get(meta.ip) ?? 1) - 1;
      if (remaining > 0) {
        this.connectionsByIp.set(meta.ip, remaining);
      } else {
        this.connectionsByIp.delete(meta.ip);
      }
      this.connectionMeta.delete(callId);
    }
    this.sessions.delete(callId);
  }

  private handleMessage(callId: string, data: RawData): void {
    const text = rawDataToString(data);
    if (text === null) {
      return;
    }

    let parsed: InboundMessage;
    try {
      parsed = InboundMessageSchema.parse(JSON.parse(text));
    } catch (err) {
      this.config.logger?.warn(
        `MsteamsMediaStream: invalid message from ${callId}: ${(err as Error).message}`,
      );
      return;
    }

    switch (parsed.type) {
      case "session.start": {
        // The callId is authenticated via HMAC in the URL path; a session.start
        // body claiming a different callId must be rejected, otherwise the call
        // record and the send/close closures would key off different ids.
        if (parsed.callId !== callId) {
          this.config.logger?.warn(
            `MsteamsMediaStream: session.start callId mismatch (authenticated=${callId} payload=${parsed.callId}); closing`,
          );
          this.closeSession(callId, "callid-mismatch");
          return;
        }
        const meta = this.connectionMeta.get(callId);
        if (meta) {
          meta.started = true;
          clearTimeout(meta.preStartTimer);
        }
        this.config.onSessionStart?.({
          callId,
          threadId: parsed.threadId,
          // Blank ids become null at the boundary: an empty-string aadId would survive every
          // downstream `aadId ?? fallback` and collapse all such callers into one session key
          // (cross-caller memory bleed) or one delivery target.
          caller: {
            aadId: blankToNull(parsed.caller.aadId),
            displayName: blankToNull(parsed.caller.displayName),
            tenantId: blankToNull(parsed.caller.tenantId),
          },
          recordingStatus: parsed.recordingStatus,
          direction: parsed.direction,
          send: (message) => this.sendTo(callId, message),
          close: (reason) => this.closeSession(callId, reason),
        });
        break;
      }
      case "recording.status": {
        this.config.onRecordingStatus?.({ callId, status: parsed.status });
        break;
      }
      case "session.end": {
        const meta = this.connectionMeta.get(callId);
        if (meta) {
          meta.ended = true;
        }
        this.config.onSessionEnd?.({ callId, reason: parsed.reason });
        this.closeSession(callId, parsed.reason);
        break;
      }
      case "audio.frame": {
        this.config.onAudioFrame?.({
          callId,
          seq: parsed.seq,
          timestampMs: parsed.timestampMs,
          payload: Buffer.from(parsed.payloadBase64, "base64"),
          speakerName: parsed.speakerName,
        });
        break;
      }
      case "video.frame": {
        this.config.onVideoFrame?.({
          callId,
          source: parsed.source,
          ts: parsed.ts,
          width: parsed.width,
          height: parsed.height,
          mime: parsed.mime,
          dataBase64: parsed.dataBase64,
          participantId: parsed.participantId,
          participantName: parsed.participantName,
        });
        break;
      }
      case "participants": {
        this.config.onParticipants?.({ callId, count: parsed.count });
        break;
      }
      case "dtmf": {
        this.config.onDtmf?.({ callId, digit: parsed.digit });
        break;
      }
      case "ping": {
        this.sendTo(callId, { type: "pong", ts: parsed.ts });
        break;
      }
    }
  }

  // Returns whether the message was actually sent. A closed/missing socket drops it (false) rather
  // than throwing, so best-effort control frames stay no-ops while delivery-sensitive callers (audio
  // frames) can observe the drop and abort.
  private sendTo(callId: string, message: unknown): boolean {
    const ws = this.sessions.get(callId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  private closeSession(callId: string, reason: string): void {
    const ws = this.sessions.get(callId);
    if (!ws) {
      return;
    }
    // A host-initiated close must still deliver onSessionEnd for a started session:
    // cleanupConnection below deletes the connection meta, so by the time the ws
    // close event fires there is no meta and the close handler skips delivery —
    // which leaked host call state on paths like a realtime connect-failure close
    // (the call stayed "in-progress" forever). The `ended` guard keeps a
    // session.end-driven close single-delivery.
    const meta = this.connectionMeta.get(callId);
    if (meta?.started && !meta.ended) {
      meta.ended = true;
      this.config.onSessionEnd?.({ callId, reason });
    }
    try {
      ws.close(1000, reason);
    } catch {
      // ignore
    }
    this.cleanupConnection(callId);
  }

  private rejectUpgrade(socket: Duplex, code: number, reason: string): void {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

/** Blank/whitespace-only strings become null so downstream `?? fallback` checks fire. */
function blankToNull(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

function normalizeIp(raw: string | undefined): string {
  if (!raw) {
    return "unknown";
  }
  // Collapse IPv4-mapped IPv6 (::ffff:1.2.3.4 -> 1.2.3.4) for stable per-IP keys.
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
}

function rawDataToString(data: RawData): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  // ArrayBuffer fallback
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return null;
}
