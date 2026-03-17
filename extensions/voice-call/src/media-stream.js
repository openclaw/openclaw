import { WebSocket, WebSocketServer } from "ws";
const DEFAULT_PRE_START_TIMEOUT_MS = 5e3;
const DEFAULT_MAX_PENDING_CONNECTIONS = 32;
const DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP = 4;
const DEFAULT_MAX_CONNECTIONS = 128;
class MediaStreamHandler {
  constructor(config) {
    this.wss = null;
    this.sessions = /* @__PURE__ */ new Map();
    /** Pending sockets that have upgraded but not yet sent an accepted `start` frame. */
    this.pendingConnections = /* @__PURE__ */ new Map();
    /** Pending socket count per remote IP for pre-auth throttling. */
    this.pendingByIp = /* @__PURE__ */ new Map();
    /** TTS playback queues per stream (serialize audio to prevent overlap) */
    this.ttsQueues = /* @__PURE__ */ new Map();
    /** Whether TTS is currently playing per stream */
    this.ttsPlaying = /* @__PURE__ */ new Map();
    /** Active TTS playback controllers per stream */
    this.ttsActiveControllers = /* @__PURE__ */ new Map();
    this.config = config;
    this.preStartTimeoutMs = config.preStartTimeoutMs ?? DEFAULT_PRE_START_TIMEOUT_MS;
    this.maxPendingConnections = config.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS;
    this.maxPendingConnectionsPerIp = config.maxPendingConnectionsPerIp ?? DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP;
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  }
  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request, socket, head) {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    }
    const currentConnections = this.wss.clients.size;
    if (currentConnections >= this.maxConnections) {
      this.rejectUpgrade(socket, 503, "Too many media stream connections");
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }
  /**
   * Handle new WebSocket connection from Twilio.
   */
  async handleConnection(ws, _request) {
    let session = null;
    const streamToken = this.getStreamToken(_request);
    const ip = this.getClientIp(_request);
    if (!this.registerPendingConnection(ws, ip)) {
      ws.close(1013, "Too many pending media stream connections");
      return;
    }
    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        switch (message.event) {
          case "connected":
            console.log("[MediaStream] Twilio connected");
            break;
          case "start":
            session = await this.handleStart(ws, message, streamToken);
            if (session) {
              this.clearPendingConnection(ws);
            }
            break;
          case "media":
            if (session && message.media?.payload) {
              const audioBuffer = Buffer.from(message.media.payload, "base64");
              session.sttSession.sendAudio(audioBuffer);
            }
            break;
          case "stop":
            if (session) {
              this.handleStop(session);
              session = null;
            }
            break;
        }
      } catch (error) {
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
  async handleStart(ws, message, streamToken) {
    const streamSid = message.streamSid || "";
    const callSid = message.start?.callSid || "";
    const effectiveToken = message.start?.customParameters?.token ?? streamToken;
    console.log(`[MediaStream] Stream started: ${streamSid} (call: ${callSid})`);
    if (!callSid) {
      console.warn("[MediaStream] Missing callSid; closing stream");
      ws.close(1008, "Missing callSid");
      return null;
    }
    if (this.config.shouldAcceptStream && !this.config.shouldAcceptStream({ callId: callSid, streamSid, token: effectiveToken })) {
      console.warn(`[MediaStream] Rejecting stream for unknown call: ${callSid}`);
      ws.close(1008, "Unknown call");
      return null;
    }
    const sttSession = this.config.sttProvider.createSession();
    sttSession.onPartial((partial) => {
      this.config.onPartialTranscript?.(callSid, partial);
    });
    sttSession.onTranscript((transcript) => {
      this.config.onTranscript?.(callSid, transcript);
    });
    sttSession.onSpeechStart(() => {
      this.config.onSpeechStart?.(callSid);
    });
    const session = {
      callId: callSid,
      streamSid,
      ws,
      sttSession
    };
    this.sessions.set(streamSid, session);
    this.config.onConnect?.(callSid, streamSid);
    sttSession.connect().catch((err) => {
      console.warn(`[MediaStream] STT connection failed (TTS still works):`, err.message);
    });
    return session;
  }
  /**
   * Handle stream stop event.
   */
  handleStop(session) {
    console.log(`[MediaStream] Stream stopped: ${session.streamSid}`);
    this.clearTtsState(session.streamSid);
    session.sttSession.close();
    this.sessions.delete(session.streamSid);
    this.config.onDisconnect?.(session.callId);
  }
  getStreamToken(request) {
    if (!request.url || !request.headers.host) {
      return void 0;
    }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      return url.searchParams.get("token") ?? void 0;
    } catch {
      return void 0;
    }
  }
  getClientIp(request) {
    return request.socket.remoteAddress || "unknown";
  }
  registerPendingConnection(ws, ip) {
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
        `[MediaStream] Closing pre-start idle connection after ${this.preStartTimeoutMs}ms (${ip})`
      );
      ws.close(1008, "Start timeout");
    }, this.preStartTimeoutMs);
    timeout.unref?.();
    this.pendingConnections.set(ws, { ip, timeout });
    this.pendingByIp.set(ip, pendingForIp + 1);
    return true;
  }
  clearPendingConnection(ws) {
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
  rejectUpgrade(socket, statusCode, message) {
    const statusText = statusCode === 429 ? "Too Many Requests" : "Service Unavailable";
    const body = `${message}
`;
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r
Connection: close\r
Content-Type: text/plain; charset=utf-8\r
Content-Length: ${Buffer.byteLength(body)}\r
\r
` + body
    );
    socket.destroy();
  }
  /**
   * Get an active session with an open WebSocket, or undefined if unavailable.
   */
  getOpenSession(streamSid) {
    const session = this.sessions.get(streamSid);
    return session?.ws.readyState === WebSocket.OPEN ? session : void 0;
  }
  /**
   * Send a message to a stream's WebSocket if available.
   */
  sendToStream(streamSid, message) {
    const session = this.getOpenSession(streamSid);
    session?.ws.send(JSON.stringify(message));
  }
  /**
   * Send audio to a specific stream (for TTS playback).
   * Audio should be mu-law encoded at 8kHz mono.
   */
  sendAudio(streamSid, muLawAudio) {
    this.sendToStream(streamSid, {
      event: "media",
      streamSid,
      media: { payload: muLawAudio.toString("base64") }
    });
  }
  /**
   * Send a mark event to track audio playback position.
   */
  sendMark(streamSid, name) {
    this.sendToStream(streamSid, {
      event: "mark",
      streamSid,
      mark: { name }
    });
  }
  /**
   * Clear audio buffer (interrupt playback).
   */
  clearAudio(streamSid) {
    this.sendToStream(streamSid, { event: "clear", streamSid });
  }
  /**
   * Queue a TTS operation for sequential playback.
   * Only one TTS operation plays at a time per stream to prevent overlap.
   */
  async queueTts(streamSid, playFn) {
    const queue = this.getTtsQueue(streamSid);
    let resolveEntry;
    let rejectEntry;
    const promise = new Promise((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    queue.push({
      playFn,
      controller: new AbortController(),
      resolve: resolveEntry,
      reject: rejectEntry
    });
    if (!this.ttsPlaying.get(streamSid)) {
      void this.processQueue(streamSid);
    }
    return promise;
  }
  /**
   * Clear TTS queue and interrupt current playback (barge-in).
   */
  clearTtsQueue(streamSid) {
    const queue = this.getTtsQueue(streamSid);
    queue.length = 0;
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.clearAudio(streamSid);
  }
  /**
   * Get active session by call ID.
   */
  getSessionByCallId(callId) {
    return [...this.sessions.values()].find((session) => session.callId === callId);
  }
  /**
   * Close all sessions.
   */
  closeAll() {
    for (const session of this.sessions.values()) {
      this.clearTtsState(session.streamSid);
      session.sttSession.close();
      session.ws.close();
    }
    this.sessions.clear();
  }
  getTtsQueue(streamSid) {
    const existing = this.ttsQueues.get(streamSid);
    if (existing) {
      return existing;
    }
    const queue = [];
    this.ttsQueues.set(streamSid, queue);
    return queue;
  }
  /**
   * Process the TTS queue for a stream.
   * Uses iterative approach to avoid stack accumulation from recursion.
   */
  async processQueue(streamSid) {
    this.ttsPlaying.set(streamSid, true);
    while (true) {
      const queue = this.ttsQueues.get(streamSid);
      if (!queue || queue.length === 0) {
        this.ttsPlaying.set(streamSid, false);
        this.ttsActiveControllers.delete(streamSid);
        return;
      }
      const entry = queue.shift();
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
  clearTtsState(streamSid) {
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
export {
  MediaStreamHandler
};
