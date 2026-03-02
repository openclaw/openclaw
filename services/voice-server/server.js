/**
 * Clawd Voice Server v4.0 — Gateway-Native + OpenAI TTS + Barge-In
 *
 * Pipeline:
 *   Phone → Twilio → [tunnel] → this server
 *     ↓ mulaw audio
 *   OpenAI Realtime STT → transcribed text
 *     ↓ text
 *   OpenClaw Gateway → Claude (subagent) → response text
 *     ↓ text
 *   OpenAI TTS → PCM 24kHz → downsample 8kHz → mulaw → Twilio → Phone
 *
 * Gateway auth: reads token from ~/.openclaw/openclaw.json (gateway.auth.token)
 * or OPENCLAW_GATEWAY_TOKEN env var. Token is never logged.
 *
 * Barge-in: interim STT detects speech during TTS playback → clear buffer,
 * cancel TTS, cancel pending gateway request, wait for full utterance.
 */

import { spawn } from "child_process";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

/** Normalize a ws RawData value (Buffer | ArrayBuffer | Buffer[]) to a UTF-8 string. */
function rawDataToString(data) {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Environment ─────────────────────────────────────────────────

function loadEnv() {
  // Try local .env first, then fall back to ../secrets/twilio.env
  const candidates = [resolve(__dirname, ".env"), resolve(__dirname, "../secrets/twilio.env")];
  for (const p of candidates) {
    try {
      const content = readFileSync(p, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) {
          continue;
        }
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
      console.log(`✅ Loaded env from ${p}`);
      return;
    } catch {
      /* try next */
    }
  }
  console.log("ℹ️  No .env file found, using environment variables only");
}
loadEnv();

// ─── Gateway token ────────────────────────────────────────────────

function loadGatewayToken() {
  // 1. Environment variable takes priority
  const envToken = (process.env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
  if (envToken) {
    console.log("✅ Gateway token: found in environment");
    return envToken;
  }
  // 2. Read from ~/.openclaw/openclaw.json
  const configPath = resolve(homedir(), ".openclaw", "openclaw.json");
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const token = (cfg?.gateway?.auth?.token ?? "").trim();
    if (token) {
      console.log("✅ Gateway token: found in ~/.openclaw/openclaw.json");
      return token;
    }
    console.log("⚠️  Gateway token: absent in ~/.openclaw/openclaw.json (gateway.auth.token)");
  } catch {
    console.log("⚠️  Gateway token: could not read ~/.openclaw/openclaw.json");
  }
  return null;
}

// ─── Configuration ────────────────────────────────────────────────

const CONFIG = {
  port: parseInt(process.env.PORT || "8765"),
  gatewayPort: parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789"),
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    phoneNumberSid: process.env.TWILIO_PHONE_NUMBER_SID || "PN3da7684fb5b7e360a796ba29d475aed7",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    sttModel: "gpt-4o-mini-transcribe",
    ttsModel: "tts-1",
    ttsVoice: "nova", // Warm, design-focused voice
  },
  greeting: "Hello David! It's great to hear from you. What's on your mind?",
  goodbyePhrases: ["bye", "goodbye", "talk to you later"],
  bargeIn: {
    minChars: 3, // Minimum interim transcript chars to trigger barge-in
    cooldownMs: 500, // Cooldown after barge-in before allowing another
  },
};

const VOICE_AGENT_SYSTEM_PROMPT = `You are Clawd, speaking with the caller in a live phone conversation.

Voice conversation rules:
- Keep replies concise and natural (1-3 sentences).
- Do not use markdown, bullets, code blocks, or URLs.
- Use a warm, conversational tone with natural contractions.
- If a message starts with [SYSTEM:], treat it as a high-priority instruction.
- If a message starts with [User interrupted you to say:], smoothly continue from the interruption without over-apologizing.
- If an async run/session-spawn completion update arrives, treat it as authoritative and summarize the completed result clearly.`;

let tunnelUrl = null;

// ─── OpenAI client (shared) ───────────────────────────────────────

const openaiClient = new OpenAI({ apiKey: CONFIG.openai.apiKey });

// ─── Twilio API ───────────────────────────────────────────────────

async function twilioRequest(method, path, body = null) {
  const auth = Buffer.from(`${CONFIG.twilio.apiKeySid}:${CONFIG.twilio.apiKeySecret}`).toString(
    "base64",
  );
  const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.twilio.accountSid}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) {
    opts.body = new URLSearchParams(body).toString();
  }
  return (await fetch(url, opts)).json();
}

async function updatePhoneNumberWebhook(voiceUrl) {
  console.log(`📞 Updating webhook → ${voiceUrl}`);
  const result = await twilioRequest(
    "POST",
    `/IncomingPhoneNumbers/${CONFIG.twilio.phoneNumberSid}.json`,
    {
      VoiceUrl: voiceUrl,
      VoiceMethod: "POST",
    },
  );
  if (result.sid) {
    console.log(`✅ Phone ${result.phone_number} → tunnel`);
    return true;
  }
  console.error("❌ Webhook update failed:", result);
  return false;
}

// ─── G.711 µ-law encoding ─────────────────────────────────────────

/**
 * Encode a 16-bit signed linear PCM sample to G.711 µ-law.
 * Standard CCITT implementation (BIAS=132, CLIP=32635).
 */
function linearToMulaw(sample) {
  const BIAS = 0x84; // 132
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }
  sample += BIAS;
  let exponent = 7;
  let expMask = 0x4000;
  while ((sample & expMask) === 0 && exponent > 0) {
    exponent--;
    expMask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ─── OpenAI TTS ───────────────────────────────────────────────────

/**
 * Convert text to speech using OpenAI TTS, downsample to 8kHz µ-law,
 * and stream chunks to Twilio Media Streams.
 *
 * OpenAI TTS returns raw PCM: 24kHz, 16-bit, mono (little-endian).
 * Twilio expects: G.711 µ-law, 8kHz, base64-encoded, 160-byte chunks (20ms).
 * Downsampling: average every 3 consecutive 24kHz samples → 1 8kHz sample.
 *
 * @param {string} text
 * @param {string} streamSid
 * @param {WebSocket} twilioWs
 * @param {{ cancelled: boolean }} cancelToken
 */
async function textToSpeechStream(text, streamSid, twilioWs, cancelToken = { cancelled: false }) {
  if (cancelToken.cancelled) {
    return;
  }

  const response = await openaiClient.audio.speech.create({
    model: CONFIG.openai.ttsModel,
    voice: CONFIG.openai.ttsVoice,
    input: text,
    response_format: "pcm", // Raw 16-bit PCM at 24kHz mono
  });

  if (cancelToken.cancelled) {
    return;
  }

  const pcmBuf = Buffer.from(await response.arrayBuffer());

  if (cancelToken.cancelled) {
    return;
  }

  // Downsample 24kHz → 8kHz: average each group of 3 samples (6 bytes)
  const sampleCount = Math.floor(pcmBuf.length / 6); // 3 samples × 2 bytes each
  const mulaw = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const off = i * 6;
    const s0 = pcmBuf.readInt16LE(off);
    const s1 = pcmBuf.readInt16LE(off + 2);
    const s2 = pcmBuf.readInt16LE(off + 4);
    mulaw[i] = linearToMulaw(Math.round((s0 + s1 + s2) / 3));
  }

  // Stream to Twilio in 160-byte chunks (20ms at 8kHz µ-law)
  const CHUNK = 160;
  let chunkCount = 0;
  for (let offset = 0; offset < mulaw.length; offset += CHUNK) {
    if (cancelToken.cancelled) {
      console.log("  🔇 TTS cancelled (barge-in)");
      return;
    }
    const chunk = mulaw.slice(offset, offset + CHUNK);
    if (twilioWs?.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(chunk).toString("base64") },
        }),
      );
      chunkCount++;
    }
    // Yield periodically so incoming STT events (barge-in) can be processed
    if (chunkCount > 0 && chunkCount % 50 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (!cancelToken.cancelled) {
    console.log(`  🔊 TTS done — ${chunkCount} chunks (${sampleCount} samples)`);
    if (twilioWs?.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(
        JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done-" + Date.now() } }),
      );
    }
  }
}

// ─── OpenAI Realtime STT ──────────────────────────────────────────

class OpenAIRealtimeSTT {
  constructor(onTranscript, onUtteranceEnd, onVADEvent) {
    this.ws = null;
    this.onTranscript = onTranscript;
    this.onUtteranceEnd = onUtteranceEnd;
    this.onVADEvent = onVADEvent;
    this.isConnected = false;
    this.currentTranscript = "";
    this.currentItemId = null;
  }

  connect() {
    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.ws.on("open", () => {
      console.log("  🎤 OpenAI Realtime STT connected");
      this.isConnected = true;
      this.ws.send(
        JSON.stringify({
          type: "transcription_session.update",
          session: {
            input_audio_format: "g711_ulaw",
            input_audio_noise_reduction: { type: "near_field" },
            input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }),
      );
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(rawDataToString(data));
        switch (msg.type) {
          case "transcription_session.created":
          case "transcription_session.updated":
            console.log(`  🎤 STT session ${msg.type.split(".")[1]}`);
            break;
          case "input_audio_buffer.speech_started":
            this.onVADEvent("speech_started");
            break;
          case "input_audio_buffer.committed":
            this.currentItemId = msg.item_id;
            break;
          case "conversation.item.input_audio_transcription.delta":
            if (msg.delta) {
              this.currentTranscript += msg.delta;
              this.onTranscript(this.currentTranscript, false, false);
            }
            break;
          case "conversation.item.input_audio_transcription.completed":
            if (msg.transcript) {
              const finalText = msg.transcript.trim();
              if (finalText) {
                this.currentTranscript = "";
                this.onTranscript(finalText, true, true);
                this.onUtteranceEnd();
              }
            }
            this.currentTranscript = "";
            break;
          case "error":
            console.error("  ❌ STT error:", msg.error?.message || JSON.stringify(msg.error));
            break;
        }
      } catch (err) {
        console.error("  ❌ STT parse error:", err.message);
      }
    });

    this.ws.on("error", (err) => console.error("  ❌ OpenAI STT error:", err.message));
    this.ws.on("close", () => {
      this.isConnected = false;
      console.log("  🎤 OpenAI STT disconnected");
    });
  }

  sendAudio(b64) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

// ─── Gateway Brain ────────────────────────────────────────────────

/**
 * Connects to the local OpenClaw gateway as a voice-server client.
 * Authenticates using the shared gateway token (never logged).
 * Provides think(text) → Claude response text via gateway `agent` RPC.
 *
 * Protocol:
 *   1. Gateway sends { type:"event", event:"connect.challenge", payload:{nonce} }
 *   2. Client sends { type:"req", id, method:"connect", params:{...auth:{token}} }
 *   3. Gateway sends { type:"res", id, ok:true, payload:{type:"hello-ok",...} }
 *   4. Client sends { type:"req", id, method:"agent", params:{message,...} }
 *   5. Gateway sends ack: { type:"res", id, ok:true, payload:{status:"accepted",runId} }
 *   6. Gateway sends final: { type:"res", id, ok:true, payload:{status:"ok",result:{payloads}} }
 */
class GatewayBrain {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.pendingRequests = new Map(); // id → { resolve, reject, expectFinal, timer, onAccepted? }
    this.reconnectTimer = null;
    this.token = null;
    this.gatewayPort = CONFIG.gatewayPort;
  }

  connect() {
    this.token = loadGatewayToken();
    const url = `ws://127.0.0.1:${this.gatewayPort}`;
    console.log(`🧠 Connecting to OpenClaw gateway at ${url}...`);
    this.ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });

    this.ws.on("open", () => {
      // Wait for connect.challenge event before sending auth
      console.log("🧠 Gateway WebSocket open — awaiting connect challenge");
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(rawDataToString(data));

        // Handle connect challenge → send connect request with auth
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const nonce = msg.payload?.nonce;
          if (!nonce) {
            console.error("❌ Gateway: connect challenge missing nonce");
            this.ws?.close();
            return;
          }
          this._sendConnect(nonce);
          return;
        }

        // Tick events — gateway keepalive, no action needed
        if (msg.type === "event" && msg.event === "tick") {
          return;
        }

        // Response frames
        if (msg.type === "res") {
          const pending = this.pendingRequests.get(msg.id);
          if (!pending) {
            return;
          }

          // Agent RPCs are two-stage: accepted ack first, final payload later.
          const status = msg.payload?.status;
          if (pending.expectFinal && msg.ok && status === "accepted") {
            pending.onAccepted?.({
              requestId: msg.id,
              runId: typeof msg.payload?.runId === "string" ? msg.payload.runId : null,
              acceptedAt:
                typeof msg.payload?.acceptedAt === "number" ? msg.payload.acceptedAt : Date.now(),
            });
            return;
          }

          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);

          if (msg.ok) {
            pending.resolve(msg.payload);
          } else {
            pending.reject(new Error(msg.error?.message ?? "gateway request failed"));
          }
        }
      } catch (err) {
        console.error("❌ Gateway parse error:", err.message);
      }
    });

    this.ws.on("close", (code, _reason) => {
      console.log(`🧠 Gateway disconnected (${code}) — reconnecting in 3s...`);
      this.isConnected = false;
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Gateway disconnected"));
      }
      this.pendingRequests.clear();
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on("error", (err) => {
      console.error("🧠 Gateway error:", err.message);
    });
  }

  _sendConnect(_nonce) {
    const reqId = `conn-${randomUUID()}`;

    const pending = {
      resolve: (hello) => {
        const proto = hello?.protocol ?? "?";
        const connId = hello?.server?.connId ?? "?";
        console.log(`🧠 Gateway connected — protocol v${proto}, connId: ${connId}`);
        this.isConnected = true;
      },
      reject: (err) => {
        console.error("❌ Gateway connect failed:", err.message);
      },
      expectFinal: false,
      timer: setTimeout(() => {
        this.pendingRequests.delete(reqId);
        console.error("❌ Gateway connect timeout");
        this.ws?.close();
      }, 10000),
    };
    this.pendingRequests.set(reqId, pending);

    this.ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "voice-server",
            version: "4.0",
            platform: process.platform,
            mode: "backend",
            instanceId: randomUUID(),
          },
          role: "operator",
          scopes: ["operator.admin"],
          caps: [],
          ...(this.token ? { auth: { token: this.token } } : {}),
        },
      }),
    );
  }

  /**
   * Dispatch user text via gateway `agent` in async mode.
   * Returns immediately with request metadata + a completion promise.
   */
  dispatchThink(userText, { timeoutMs = 30000, onAccepted = null } = {}) {
    if (!this.isConnected) {
      throw new Error("Gateway not connected");
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway socket not ready");
    }

    const reqId = randomUUID();
    let runId = null;

    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Gateway agent timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve: (payload) => {
          runId = typeof payload?.runId === "string" ? payload.runId : runId;
          const payloads = Array.isArray(payload?.result?.payloads) ? payload.result.payloads : [];
          const text = payloads
            .map((entry) => (typeof entry?.text === "string" ? entry.text.trim() : ""))
            .filter(Boolean)
            .join("\n\n");
          resolve({
            requestId: reqId,
            runId,
            text: text || payload?.summary?.trim() || "I'm not sure how to respond to that.",
          });
        },
        reject,
        expectFinal: true,
        onAccepted: onAccepted
          ? (accepted) => {
              runId = accepted.runId || runId;
              onAccepted({
                requestId: accepted.requestId,
                runId,
                acceptedAt: accepted.acceptedAt,
              });
            }
          : null,
        timer,
      });

      try {
        this.ws.send(
          JSON.stringify({
            type: "req",
            id: reqId,
            method: "agent",
            params: {
              message: userText,
              idempotencyKey: reqId,
              deliver: false,
              thinking: "low", // Low thinking for voice latency
              extraSystemPrompt: VOICE_AGENT_SYSTEM_PROMPT,
            },
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        reject(err);
      }
    });

    return {
      requestId: reqId,
      completion,
    };
  }

  /**
   * Compatibility helper: dispatch and await the final text.
   */
  async think(userText, timeoutMs = 30000) {
    const request = this.dispatchThink(userText, { timeoutMs });
    const result = await request.completion;
    return result.text;
  }

  cancelRequest(requestId, reason = "Cancelled") {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.reject(new Error(reason));
    return true;
  }

  /** Cancel all in-flight requests (e.g. on barge-in). */
  cancelAll(reason = "Cancelled") {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /** No-op: gateway manages its own session state. */
  notify(_event, _data = {}) {}

  close() {
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

// ─── Voice Session (with Barge-In) ───────────────────────────────

class VoiceSession {
  constructor(twilioWs, streamSid, brain) {
    this.twilioWs = twilioWs;
    this.streamSid = streamSid;
    this.brain = brain;

    this.finalizedText = "";
    this.stt = null;

    this.isProcessing = false;
    this.isSpeaking = false;

    this.currentGenerationId = 0;
    this.currentTTSCancel = null;
    this.lastBargeInTime = 0;
    this.wasInterrupted = false;
    this.currentBrainRequestId = null;
    this.currentBrainRunId = null;
  }

  async start() {
    console.log("🎙️  Voice session starting...");
    this.brain.notify("call-start");

    this.stt = new OpenAIRealtimeSTT(
      (transcript, isFinal, _speechFinal) => this.handleTranscript(transcript, isFinal),
      () => this.handleUtteranceEnd(),
      (event) => this.handleVADEvent(event),
    );
    this.stt.connect();

    await new Promise((r) => setTimeout(r, 500));

    let greeting = CONFIG.greeting;
    if (this.brain.isConnected) {
      try {
        greeting = await this.brain.think(
          "[SYSTEM: Call just connected. Greet the caller warmly and briefly.]",
          10000,
        );
      } catch {
        console.log("  ⚠️ Gateway not ready for greeting, using default");
      }
    }

    await this.speak(greeting);
    console.log("✅ Greeting sent — listening...");
  }

  handleTranscript(transcript, isFinal) {
    if (isFinal) {
      this.finalizedText += (this.finalizedText ? " " : "") + transcript;
      console.log(`  📝 [final]: "${transcript}"`);
    } else {
      process.stdout.write(`  📝 [interim]: "${transcript}"   \r`);
      if (transcript.trim().length >= CONFIG.bargeIn.minChars) {
        if (this.isSpeaking) {
          this.triggerBargeIn("speaking");
        } else if (this.isProcessing) {
          this.triggerBargeIn("thinking");
        }
      }
    }
  }

  handleUtteranceEnd() {
    const fullText = this.finalizedText.trim();
    if (!fullText) {
      return;
    }

    const wasInterrupted = this.wasInterrupted;
    this.wasInterrupted = false;
    this.finalizedText = "";

    if (wasInterrupted) {
      console.log(`\n  🗣️  User interrupted: "${fullText}"`);
    } else {
      console.log(`\n  🗣️  User said: "${fullText}"`);
    }

    const lower = fullText.toLowerCase();
    const isGoodbye = CONFIG.goodbyePhrases.some((p) => lower.includes(p));

    if (isGoodbye) {
      this.respondAndClose(fullText);
    } else {
      const textToSend = wasInterrupted ? `[User interrupted you to say:] ${fullText}` : fullText;
      this.respond(textToSend);
    }
  }

  handleVADEvent(_event) {
    // speech_started fires early; we use interim transcript text to confirm barge-in
  }

  cancelActiveBrainRequest(reason) {
    if (!this.currentBrainRequestId) {
      return;
    }
    this.brain.cancelRequest(this.currentBrainRequestId, reason);
    this.currentBrainRequestId = null;
    this.currentBrainRunId = null;
  }

  triggerBargeIn(mode) {
    const now = Date.now();
    if (now - this.lastBargeInTime < CONFIG.bargeIn.cooldownMs) {
      return;
    }

    this.lastBargeInTime = now;
    if (mode === "speaking") {
      console.log("\n  🛑 BARGE-IN — stopping playback, listening...");
      this.clearTwilioBuffer();
    } else {
      console.log("\n  🛑 BARGE-IN — cancelling pending brain run, listening...");
    }

    if (mode === "speaking" && this.currentTTSCancel) {
      this.currentTTSCancel.cancelled = true;
    }

    this.currentGenerationId++;
    this.cancelActiveBrainRequest("Cancelled (barge-in)");

    this.isSpeaking = false;
    this.isProcessing = false;
    this.wasInterrupted = mode === "speaking";
  }

  respond(userText) {
    const myGeneration = ++this.currentGenerationId;
    this.isProcessing = true;
    this.cancelActiveBrainRequest("Cancelled (superseded by newer utterance)");

    const t0 = Date.now();
    let request = null;
    try {
      request = this.brain.dispatchThink(userText, {
        timeoutMs: 30000,
        onAccepted: ({ requestId, runId }) => {
          if (
            this.currentGenerationId !== myGeneration ||
            this.currentBrainRequestId !== requestId
          ) {
            return;
          }
          this.currentBrainRunId = runId;
          console.log(
            `  🧠 ↗ Gateway accepted${runId ? ` run ${runId.slice(0, 8)}` : ""} [${requestId.slice(0, 8)}]`,
          );
        },
      });
    } catch (err) {
      this.isProcessing = false;
      console.error("  ❌ respond dispatch error:", err.message);
      void this.speak(
        "I'm sorry, I'm having a little trouble thinking right now. Could you say that again?",
      );
      return;
    }

    this.currentBrainRequestId = request.requestId;
    this.currentBrainRunId = null;
    console.log(
      `  🧠 → Gateway: "${userText.slice(0, 70)}${userText.length > 70 ? "..." : ""}" [${request.requestId.slice(0, 8)}]`,
    );

    void request.completion
      .then(async ({ runId, text }) => {
        if (
          this.currentGenerationId !== myGeneration ||
          this.currentBrainRequestId !== request.requestId
        ) {
          console.log(
            `  ⏩ Response discarded (superseded) [req ${request.requestId.slice(0, 8)}]`,
          );
          return;
        }

        this.currentBrainRunId = runId || this.currentBrainRunId;
        console.log(
          `  🧠 ← Gateway${this.currentBrainRunId ? ` run ${this.currentBrainRunId.slice(0, 8)}` : ""} (${Date.now() - t0}ms): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
        );
        await this.speak(text);
      })
      .catch(async (err) => {
        if (
          this.currentGenerationId !== myGeneration ||
          this.currentBrainRequestId !== request.requestId
        ) {
          return;
        }
        if (err.message.includes("Cancelled")) {
          return;
        }
        console.error("  ❌ respond error:", err.message);
        await this.speak(
          "I'm sorry, I'm having a little trouble thinking right now. Could you say that again?",
        );
      })
      .finally(() => {
        if (
          this.currentGenerationId === myGeneration &&
          this.currentBrainRequestId === request.requestId
        ) {
          this.isProcessing = false;
          this.currentBrainRequestId = null;
          this.currentBrainRunId = null;
        }
      });
  }

  respondAndClose(userText) {
    const myGeneration = ++this.currentGenerationId;
    this.isProcessing = true;
    this.cancelActiveBrainRequest("Cancelled (superseded by goodbye)");

    const t0 = Date.now();
    let request = null;
    try {
      request = this.brain.dispatchThink(userText, {
        timeoutMs: 30000,
        onAccepted: ({ requestId, runId }) => {
          if (
            this.currentGenerationId !== myGeneration ||
            this.currentBrainRequestId !== requestId
          ) {
            return;
          }
          this.currentBrainRunId = runId;
          console.log(
            `  🧠 ↗ Gateway accepted${runId ? ` run ${runId.slice(0, 8)}` : ""} [${requestId.slice(0, 8)}]`,
          );
        },
      });
    } catch {
      this.isProcessing = false;
      void this.speak("Goodbye David! Talk to you soon.");
      this.brain.notify("call-end");
      setTimeout(() => this.close(), 3000);
      return;
    }

    this.currentBrainRequestId = request.requestId;
    this.currentBrainRunId = null;
    console.log(
      `  🧠 → Gateway: "${userText.slice(0, 70)}${userText.length > 70 ? "..." : ""}" [${request.requestId.slice(0, 8)}]`,
    );

    void request.completion
      .then(async ({ runId, text }) => {
        if (
          this.currentGenerationId !== myGeneration ||
          this.currentBrainRequestId !== request.requestId
        ) {
          return;
        }
        this.currentBrainRunId = runId || this.currentBrainRunId;
        console.log(
          `  👋 Goodbye${this.currentBrainRunId ? ` run ${this.currentBrainRunId.slice(0, 8)}` : ""} (${Date.now() - t0}ms): "${text}"`,
        );
        await this.speak(text);
        this.brain.notify("call-end");
        setTimeout(() => {
          console.log("📞 Call ended (goodbye)");
          this.close();
        }, 5000);
      })
      .catch(async () => {
        if (
          this.currentGenerationId !== myGeneration ||
          this.currentBrainRequestId !== request.requestId
        ) {
          return;
        }
        await this.speak("Goodbye David! Talk to you soon.");
        this.brain.notify("call-end");
        setTimeout(() => this.close(), 3000);
      })
      .finally(() => {
        if (
          this.currentGenerationId === myGeneration &&
          this.currentBrainRequestId === request.requestId
        ) {
          this.isProcessing = false;
          this.currentBrainRequestId = null;
          this.currentBrainRunId = null;
        }
      });
  }

  async speak(text) {
    const cancelToken = { cancelled: false };
    this.currentTTSCancel = cancelToken;
    this.isSpeaking = true;

    try {
      await textToSpeechStream(text, this.streamSid, this.twilioWs, cancelToken);
    } catch (err) {
      if (!cancelToken.cancelled) {
        console.error("  ❌ TTS error:", err.message);
      }
    } finally {
      if (!cancelToken.cancelled) {
        this.isSpeaking = false;
        this.currentTTSCancel = null;
      }
    }
  }

  clearTwilioBuffer() {
    if (this.twilioWs?.readyState === WebSocket.OPEN && this.streamSid) {
      this.twilioWs.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
      console.log("  🔇 Cleared Twilio audio buffer");
    }
  }

  sendAudioToSTT(b64) {
    this.stt?.sendAudio(b64);
  }

  close() {
    this.cancelActiveBrainRequest("Cancelled (session closed)");
    this.stt?.close();
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      this.twilioWs.close();
    }
    console.log("🔴 Session closed");
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "clawd-voice",
        version: "4.0",
        tunnel: tunnelUrl,
        gatewayConnected: brain.isConnected,
      }),
    );
    return;
  }
  if (url.pathname === "/twiml") {
    const wssUrl = tunnelUrl
      ? tunnelUrl.replace("https://", "wss://") + "/stream"
      : `wss://localhost:${CONFIG.port}/stream`;
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Connect>\n        <Stream url="${wssUrl}" />\n    </Connect>\n</Response>`,
    );
    console.log(`📞 Served TwiML`);
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

// ─── WebSocket Server (Twilio) ────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

const brain = new GatewayBrain();

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected");
  let session = null;

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(rawDataToString(data));
      switch (msg.event) {
        case "connected":
          console.log(`📞 Protocol: ${msg.protocol} ${msg.version}`);
          break;
        case "start":
          console.log(`📞 Stream: ${msg.start.streamSid}`);
          session = new VoiceSession(ws, msg.start.streamSid, brain);
          await session.start();
          break;
        case "media":
          session?.sendAudioToSTT(msg.media?.payload);
          break;
        case "mark":
          break;
        case "stop":
          console.log("📞 Stream stopped");
          session?.close();
          break;
      }
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("📞 Twilio disconnected");
    session?.close();
  });
  ws.on("error", (err) => console.error("❌ WS error:", err.message));
});

// ─── ngrok Tunnel ─────────────────────────────────────────────────

async function startTunnel() {
  // Pre-configure auth token if provided (enables longer sessions + custom domains).
  const authToken = (process.env.NGROK_AUTH_TOKEN ?? "").trim();
  const domain = (process.env.NGROK_DOMAIN ?? "").trim();
  if (authToken) {
    await new Promise((res, rej) => {
      const p = spawn("ngrok", ["config", "add-authtoken", authToken], { stdio: "ignore" });
      p.on("close", (code) =>
        code === 0 ? res() : rej(new Error(`ngrok config failed (${code})`)),
      );
      p.on("error", rej);
    });
  }

  const args = ["http", String(CONFIG.port), "--log", "stdout", "--log-format", "json"];
  if (domain) {
    args.push("--domain", domain);
  }

  return new Promise((resolve, reject) => {
    console.log("🔒 Starting ngrok tunnel...");
    const ng = spawn("ngrok", args, { stdio: ["ignore", "pipe", "pipe"] });

    let resolved = false;
    let outputBuffer = "";

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ng.kill("SIGTERM");
        reject(new Error("ngrok startup timed out (30s)"));
      }
    }, 30000);

    const processLine = (line) => {
      try {
        const log = JSON.parse(line);
        // ngrok emits a 'started tunnel' JSON line with the public URL
        if ((log.msg === "started tunnel" || (log.addr && log.url)) && log.url && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          tunnelUrl = log.url;
          console.log(`🔒 ngrok tunnel: ${tunnelUrl}`);
          resolve(tunnelUrl);
        }
      } catch {
        /* non-JSON startup lines */
      }
    };

    ng.stdout.on("data", (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          processLine(line);
        }
      }
    });
    ng.stderr.on("data", () => {}); // ngrok logs go to stdout in JSON mode
    ng.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    ng.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok exited (${code})`));
      }
    });

    // Forward shutdown signals to the ngrok child process.
    process.on("SIGINT", () => {
      ng.kill("SIGTERM");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      ng.kill("SIGTERM");
      process.exit(0);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎙️  Clawd Voice Server v4.0 — OpenClaw Gateway + OpenAI STT/TTS + Barge-In\n`);

  // Validate required credentials
  const missing = [];
  if (!CONFIG.twilio.accountSid) {
    missing.push("TWILIO_ACCOUNT_SID");
  }
  if (!CONFIG.openai.apiKey) {
    missing.push("OPENAI_API_KEY");
  }
  if (missing.length) {
    console.error("❌ Missing:", missing.join(", "));
    process.exit(1);
  }
  console.log("✅ Credentials loaded");

  // 1. Start HTTP/WS server
  await new Promise((r) => httpServer.listen(CONFIG.port, r));
  console.log(`✅ Server on port ${CONFIG.port}`);

  // 2. Connect to OpenClaw gateway
  brain.connect();

  // 3. Start tunnel
  try {
    await startTunnel();
  } catch (err) {
    console.error("❌ Tunnel failed:", err.message);
    process.exit(1);
  }

  // 4. Auto-update Twilio webhook
  await updatePhoneNumberWebhook(`${tunnelUrl}/twiml`);

  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🟢 VOICE SERVER v4.0 READY                               ║
║  Call ${CONFIG.twilio.phoneNumber ?? "(phone N/A)"} to talk!${" ".repeat(Math.max(0, 33 - (CONFIG.twilio.phoneNumber ?? "(phone N/A)").length))}║
╠════════════════════════════════════════════════════════════╣
║  STT:      OpenAI Realtime (gpt-4o-mini-transcribe)       ║
║  TTS:      OpenAI (nova, tts-1)                           ║
║  Brain:    OpenClaw Gateway → Claude (port ${CONFIG.gatewayPort})         ║
║  Tunnel:   ${tunnelUrl || "none"}${" ".repeat(Math.max(0, 47 - (tunnelUrl || "").length))}║
║  Barge-In: ✅ Enabled (${CONFIG.bargeIn.minChars}+ chars trigger)              ║
║  🔒 Zero open ports · Auto-configured                     ║
╚════════════════════════════════════════════════════════════╝
  `);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
