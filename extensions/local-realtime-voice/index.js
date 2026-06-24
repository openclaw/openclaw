import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";

const PREFIX = "[local-realtime]";
const log = (...args) => console.error(PREFIX, ...args);

const G711_ULAW_8KHZ = { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 };
const PCM16_24KHZ = { encoding: "pcm16", sampleRateHz: 24000, channels: 1 };

function resolveConfig(rawConfig) {
  return {
    whisperBaseUrl: rawConfig?.whisperBaseUrl ?? "http://127.0.0.1:8000",
    whisperModel: rawConfig?.whisperModel ?? "",
    kokoroBaseUrl: rawConfig?.kokoroBaseUrl ?? "http://127.0.0.1:8880",
    kokoroVoice: rawConfig?.kokoroVoice ?? "af",
    ollamaBaseUrl: rawConfig?.ollamaBaseUrl ?? "http://127.0.0.1:11434",
    chatModel: rawConfig?.chatModel,
    silenceMs: rawConfig?.silenceMs ?? 1200,
    maxTurnMs: rawConfig?.maxTurnMs ?? 15000,
    vadThreshold: rawConfig?.vadThreshold ?? 100,
    partialIntervalMs: rawConfig?.partialIntervalMs ?? 2000,
    audioChunkMs: rawConfig?.audioChunkMs ?? 50,
    useMainAgent: rawConfig?.useMainAgent === true,
    mainAgentSessionKey: rawConfig?.mainAgentSessionKey ?? "main",
    gatewayUrl: rawConfig?.gatewayUrl ?? "ws://127.0.0.1:18789",
    gatewayToken: rawConfig?.gatewayToken,
    voiceInstructions: rawConfig?.voiceInstructions ?? "The user is speaking via a realtime voice session. Keep your reply concise and natural. Avoid long outputs unless asked; prefer summaries.",
  };
}

function resolveOllamaModel(cfg, config) {
  if (config.chatModel) return config.chatModel;
  const primary = cfg?.agents?.defaults?.model?.primary;
  if (primary && primary.startsWith("ollama/")) return primary.slice("ollama/".length);
  return "kimi-k2.7-code:cloud";
}

function resolveOllamaBaseUrl(cfg, config) {
  if (config.ollamaBaseUrl) return config.ollamaBaseUrl;
  return cfg?.models?.providers?.ollama?.baseUrl ?? "http://127.0.0.1:11434";
}

function resolveGatewayToken(config) {
  if (config.gatewayToken) return config.gatewayToken;
  try {
    const home = os.homedir();
    const cfgPath = path.join(home, ".openclaw", "openclaw.json");
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    return raw?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

function extractCompleteSentences(text) {
  const sentences = [];
  const re = /([.!?])(\s+|$)/g;
  let lastEnd = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const sentence = text.slice(lastEnd, end).trim();
    if (sentence) sentences.push(sentence);
    lastEnd = end;
  }
  const remainder = text.slice(lastEnd);
  return { sentences, remainder };
}

async function runFfmpeg(inputArgs, outputArgs, inputBuffer) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", ...inputArgs, "-i", "pipe:0", ...outputArgs, "pipe:1"];
    log("ffmpeg", args.join(" "));
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        log("ffmpeg failed", code, stderr);
        return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.write(inputBuffer);
    child.stdin.end();
  });
}

function decodeMuLaw(buffer) {
  const exp_lut = [0, 132, 396, 924, 1980, 4092, 8316, 16764];
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let b = ~buffer[i] & 0xFF;
    const sign = (b & 0x80) ? -1 : 1;
    const exponent = (b >> 4) & 0x07;
    const mantissa = b & 0x0F;
    let sample = exp_lut[exponent] + (mantissa << (exponent + 3));
    if (exponent === 0) sample = (mantissa << 4) + 8;
    out[i] = sign * sample;
  }
  return Buffer.from(out.buffer);
}

function encodeMuLaw(pcm16) {
  const BIAS = 0x84;
  const out = Buffer.alloc(pcm16.length / 2);
  for (let i = 0; i < pcm16.length / 2; i++) {
    let sample = pcm16.readInt16LE(i * 2);
    const sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = Math.min(sample, 32767);
    sample += BIAS;
    let seg;
    for (seg = 0; seg < 8; seg++) {
      if (sample <= (0x80 << seg)) break;
    }
    if (seg >= 8) seg = 7;
    const uval = sign | (seg << 4) | (((sample >> (seg + 3)) & 0x0F));
    out[i] = ~uval & 0xFF;
  }
  return out;
}

function buildWav(pcm16, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

async function whisperTranscribe(pcm16_16k, config) {
  const wav = buildWav(pcm16_16k, 16000);
  const tmp = path.join(os.tmpdir(), `local-whisper-${randomUUID()}.wav`);
  await fs.writeFile(tmp, wav);
  try {
    const fileData = await fs.readFile(tmp);
    const blob = new Blob([fileData], { type: "audio/wav" });
    const body = new FormData();
    body.append("file", blob, "audio.wav");
    body.append("language", "en");
    body.append("response_format", "json");
    if (config.whisperModel) body.append("model", config.whisperModel);
    log("whisper request", tmp, pcm16_16k.length);
    const res = await fetch(`${config.whisperBaseUrl}/v1/audio/transcriptions`, { method: "POST", body });
    if (!res.ok) throw new Error(`Whisper STT ${res.status}: ${await res.text()}`);
    const json = await res.json();
    log("whisper result", JSON.stringify(json));
    return json.text ?? "";
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function* ollamaChat(model, messages, baseUrl) {
  log("ollama request", model, messages.length);
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama chat ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const text = obj.message?.content ?? "";
        if (text) yield { text, done: obj.done ?? false };
      } catch {}
    }
  }
}

async function kokoroSpeak(text, config) {
  log("kokoro request", text.slice(0, 80));
  const res = await fetch(`${config.kokoroBaseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "kokoro",
      input: text,
      voice: config.kokoroVoice,
      response_format: "wav",
    }),
  });
  if (!res.ok) throw new Error(`Kokoro TTS ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  log("kokoro response bytes", buf.length);
  return buf;
}

function stripWavHeader(buf) {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return buf.slice(44);
  }
  return buf;
}

// --- Gateway chat client (turn voice into normal chat I/O) ---

class GatewayChatClient {
  constructor({ url, token, sessionKey }) {
    this.url = url;
    this.token = token;
    this.sessionKey = sessionKey;
    this.ws = null;
    this.connectPromise = null;
    this.runId = null;
    this.onDelta = null;
    this.onFinal = null;
    this.onError = null;
  }

  async ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let resolved = false;
      const finish = (fn, arg) => {
        if (resolved) return;
        resolved = true;
        this.connectPromise = null;
        fn(arg);
      };
      ws.on("open", () => {
        const frame = {
          type: "req",
          id: randomUUID(),
          method: "connect",
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: { id: "gateway-client", version: "2026.6.6", platform: "linux", mode: "backend" },
            role: "operator",
            scopes: ["operator.write"],
            auth: { token: this.token }
          }
        };
        ws.send(JSON.stringify(frame));
      });
      ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === "res" && frame.ok && frame.payload?.type === "hello-ok") {
            return finish(resolve);
          }
          if (frame.type === "res" && !frame.ok) {
            return finish(reject, new Error(frame.error?.message || "gateway connect failed"));
          }
          if (frame.type === "event" && frame.event === "chat") {
            const p = frame.payload;
            if (p.runId !== this.runId) return;
            if (p.state === "delta" && p.deltaText) {
              this.onDelta?.(p.deltaText, false);
            } else if (p.state === "final") {
              this.onFinal?.();
            } else if (p.state === "error") {
              this.onError?.(new Error(p.errorMessage || "chat error"));
            }
          }
        } catch (err) {
          this.onError?.(err);
        }
      });
      ws.on("error", (err) => finish(reject, err));
      ws.on("close", () => { this.ws = null; });
    });
    return this.connectPromise;
  }

  async sendMessage(message, instruction) {
    await this.ensureConnected();
    const runId = randomUUID();
    this.runId = runId;
    const fullMessage = instruction ? `${instruction}\n\nUser said: ${message}` : message;
    this.ws.send(JSON.stringify({
      type: "req",
      id: randomUUID(),
      method: "chat.send",
      params: {
        sessionKey: this.sessionKey,
        message: fullMessage,
        idempotencyKey: runId,
        deliver: true
      }
    }));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

// --- Realtime transcription session (dictation) ---

class LocalRealtimeTranscriptionSession {
  constructor(config) {
    this.config = resolveConfig(config.providerConfig);
    this.callbacks = config;
    this.ulawBuffer = Buffer.alloc(0);
    this.pcm8kProcessedBytes = 0;
    this.lastPartial = "";
    this.closed = false;
    this.partialTimer = null;
    this.partialIntervalMs = Math.max(1500, this.config.partialIntervalMs ?? 2000);
  }

  async connect() {
    log("transcription connect");
    this.schedulePartial();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.partialTimer) { clearTimeout(this.partialTimer); this.partialTimer = null; }
    log("transcription close, bytes", this.ulawBuffer.length);
    this.finalize().catch((err) => this.callbacks.onError?.(err));
  }

  sendAudio(audio) {
    this.ulawBuffer = Buffer.concat([this.ulawBuffer, Buffer.from(audio)]);
    log("transcription audio", audio.length, "total", this.ulawBuffer.length);
  }

  schedulePartial() {
    if (this.closed) return;
    this.partialTimer = setTimeout(() => this.runPartial(), this.partialIntervalMs);
  }

  async runPartial() {
    if (this.closed) return;
    try {
      const totalBytes = this.ulawBuffer.length;
      if (totalBytes - this.pcm8kProcessedBytes >= 8000) {
        const chunk = this.ulawBuffer.slice(this.pcm8kProcessedBytes);
        const pcm8k = decodeMuLaw(chunk);
        const pcm16k = await runFfmpeg(["-f", "s16le", "-ar", "8000", "-ac", "1"], ["-f", "s16le", "-ar", "16000", "-ac", "1"], pcm8k);
        const text = await whisperTranscribe(pcm16k, this.config);
        log("transcription partial", text);
        if (text && text !== this.lastPartial) {
          this.callbacks.onPartial?.(text);
          this.lastPartial = text;
        }
        this.pcm8kProcessedBytes = totalBytes;
      }
    } catch (err) {
      log("transcription partial error", err);
    } finally {
      this.schedulePartial();
    }
  }

  async finalize() {
    if (this.ulawBuffer.length === 0) {
      this.callbacks.onTranscript?.("");
      return;
    }
    try {
      const pcm8k = decodeMuLaw(this.ulawBuffer);
      const pcm16k = await runFfmpeg(["-f", "s16le", "-ar", "8000", "-ac", "1"], ["-f", "s16le", "-ar", "16000", "-ac", "1"], pcm8k);
      const text = await whisperTranscribe(pcm16k, this.config);
      log("transcription final", text);
      this.callbacks.onTranscript?.(text || this.lastPartial);
    } catch (err) {
      this.callbacks.onError?.(err);
    }
  }
}

// --- Realtime voice session ---

class LocalRealtimeVoiceBridge {
  constructor(config) {
    this.config = config;
    this.connected = false;
    this.audioFormat = config.audioFormat ?? PCM16_24KHZ;
    this.providerConfig = resolveConfig(config.providerConfig);
    this.pcmBuffer = Buffer.alloc(0);
    this.speechStarted = false;
    this.lastSpeechAt = 0;
    this.turnStartAt = 0;
    this.responsePending = false;
    this.silenceTimer = null;
    this.turnTimer = null;
    this.isSpeaking = false;
    this.responseIsSpeaking = false;
    this.speakingCooldownTimer = null;
    this.inCooldown = false;
    this.totalAudioBytesSent = 0;
    this.messages = [{ role: "system", content: config.instructions ?? "You are a helpful voice assistant. Keep replies short and natural. Answer directly; do not say you will check, search, or look something up unless you actually have a tool to do so." }];
    this.chatModel = resolveOllamaModel(config.cfg, this.providerConfig);
    this.ollamaBaseUrl = resolveOllamaBaseUrl(config.cfg, this.providerConfig);
    this.useMainAgent = this.providerConfig.useMainAgent;
    this.mainAgentSessionKey = this.providerConfig.mainAgentSessionKey;
    this.voiceInstructions = this.providerConfig.voiceInstructions;
    this.gatewayClient = this.useMainAgent
      ? new GatewayChatClient({
          url: this.providerConfig.gatewayUrl,
          token: resolveGatewayToken(this.providerConfig),
          sessionKey: this.providerConfig.mainAgentSessionKey,
        })
      : null;
    log("voice bridge created", this.audioFormat, "model", this.chatModel, "useMainAgent", this.useMainAgent);
  }

  async connect() {
    this.connected = true;
    this.isSpeaking = false;
    this.responseIsSpeaking = false;
    this.inCooldown = false;
    this.totalAudioBytesSent = 0;
    this.clearTimers();
    log("voice connect");
    this.config.onReady?.();
  }

  close() {
    this.connected = false;
    this.isSpeaking = false;
    this.responseIsSpeaking = false;
    this.inCooldown = false;
    this.totalAudioBytesSent = 0;
    this.clearTimers();
    this.gatewayClient?.close();
    log("voice close");
    this.config.onClose?.("completed");
  }

  isConnected() {
    return this.connected;
  }

  setMediaTimestamp() {}
  acknowledgeMark() {}

  triggerGreeting(instructions) {
    log("voice greeting", instructions);
    this.sendUserMessage(instructions ?? "Greet the user briefly.");
  }

  sendUserMessage(text) {
    log("voice sendUserMessage", text);
    if (this.responsePending) return;
    this.messages.push({ role: "user", content: text });
    this.runResponse(text);
  }

  clearTimers() {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    if (this.speakingCooldownTimer) { clearTimeout(this.speakingCooldownTimer); this.speakingCooldownTimer = null; }
  }

  resetTurn() {
    this.pcmBuffer = Buffer.alloc(0);
    this.speechStarted = false;
    this.lastSpeechAt = 0;
    this.turnStartAt = 0;
  }

  beginCooldown(extraMs = 200) {
    this.isSpeaking = false;
    this.responseIsSpeaking = false;
    this.inCooldown = true;
    if (this.speakingCooldownTimer) { clearTimeout(this.speakingCooldownTimer); this.speakingCooldownTimer = null; }
    const bytesPerChannel = this.audioFormat.encoding === "g711_ulaw" ? 1 : 2;
    const bytesPerMs = ((this.audioFormat.sampleRateHz || 24000) * bytesPerChannel) / 1000;
    const playbackMs = this.totalAudioBytesSent / bytesPerMs;
    const cooldownMs = Math.max(600, Math.round(playbackMs + extraMs));
    log("voice cooldown", cooldownMs, "ms");
    this.speakingCooldownTimer = setTimeout(() => {
      this.inCooldown = false;
      this.speakingCooldownTimer = null;
    }, cooldownMs);
  }

  async speakSentence(text, { markEvent = true } = {}) {
    if (!text.trim()) return;
    try {
      log("voice speak chunk", text);
      const wav = await kokoroSpeak(text, this.providerConfig);
      let audio = stripWavHeader(wav);
      if (this.audioFormat.encoding === "g711_ulaw") {
        const pcm8k = await runFfmpeg(["-f", "s16le", "-ar", "24000", "-ac", "1"], ["-f", "s16le", "-ar", "8000", "-ac", "1"], audio);
        audio = encodeMuLaw(pcm8k);
      }
      log("voice audio out bytes", audio.length);
      const bytesPerChannel = this.audioFormat.encoding === "g711_ulaw" ? 1 : 2;
      const bytesPerMs = (this.audioFormat.sampleRateHz || 24000) * bytesPerChannel / 1000;
      const chunkBytes = Math.max(2400, Math.round((this.providerConfig.audioChunkMs ?? 50) * bytesPerMs));
      this.totalAudioBytesSent += audio.length;
      for (let offset = 0; offset < audio.length; offset += chunkBytes) {
        this.config.onAudio(audio.slice(offset, offset + chunkBytes));
      }
      if (markEvent) {
        this.config.onEvent?.({ type: "response.audio.delta", direction: "server" });
      }
    } catch (e) {
      log("voice speak chunk error", e);
      this.config.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async streamResponseFromOllama() {
    const stream = ollamaChat(this.chatModel, this.messages, this.ollamaBaseUrl);
    let sentenceBuffer = "";
    let fullText = "";
    for await (const chunk of stream) {
      fullText += chunk.text;
      sentenceBuffer += chunk.text;
      this.config.onTranscript?.("assistant", chunk.text, false);
      const { sentences, remainder } = extractCompleteSentences(sentenceBuffer);
      sentenceBuffer = remainder;
      for (const s of sentences) {
        await this.speakSentence(s);
      }
    }
    if (sentenceBuffer.trim()) {
      fullText += sentenceBuffer;
      await this.speakSentence(sentenceBuffer);
    }
    return fullText;
  }

  async streamResponseFromMainAgent(transcript) {
    let sentenceBuffer = "";
    let fullText = "";
    let processing = false;
    let finalPending = false;
    let finalResolver;
    const finalPromise = new Promise((resolve) => { finalResolver = resolve; });

    const flush = async (force) => {
      const { sentences, remainder } = extractCompleteSentences(sentenceBuffer);
      sentenceBuffer = remainder;
      for (const s of sentences) {
        fullText += s;
        await this.speakSentence(s);
      }
      if (force && remainder.trim()) {
        fullText += remainder;
        await this.speakSentence(remainder);
        sentenceBuffer = "";
      }
    };

    const processBuffer = async () => {
      if (processing) return;
      processing = true;
      try {
        await flush(false);
      } finally {
        processing = false;
        if (finalPending) await flush(true).then(() => finalResolver());
      }
    };

    this.gatewayClient.onDelta = (text) => {
      sentenceBuffer += text;
      this.config.onTranscript?.("assistant", text, false);
      processBuffer();
    };
    this.gatewayClient.onFinal = () => {
      finalPending = true;
      processBuffer();
    };
    this.gatewayClient.onError = (err) => {
      log("gateway chat error", err);
      finalResolver();
    };

    await this.gatewayClient.sendMessage(transcript, this.voiceInstructions);
    await finalPromise;
    if (sentenceBuffer.trim()) {
      fullText += sentenceBuffer;
      await this.speakSentence(sentenceBuffer);
      sentenceBuffer = "";
    }
    return fullText;
  }

  sendAudio(audio) {
    if (!this.connected || this.isSpeaking || this.inCooldown) return;
    const buf = Buffer.from(audio);
    let pcm;
    if (this.audioFormat.encoding === "g711_ulaw") {
      pcm = decodeMuLaw(buf);
    } else if (this.audioFormat.encoding === "pcm16") {
      pcm = buf;
    } else {
      this.config.onError?.(new Error(`Unsupported audio format ${this.audioFormat.encoding}`));
      return;
    }

    const energy = this.computeEnergy(pcm);
    const now = Date.now();

    if (this.pcmBuffer.length === 0) this.turnStartAt = now;
    this.pcmBuffer = Buffer.concat([this.pcmBuffer, pcm]);

    const wasSpeaking = this.speechStarted;
    if (energy > this.providerConfig.vadThreshold) {
      this.speechStarted = true;
      this.lastSpeechAt = now;
      if (!wasSpeaking) {
        log("voice speech started, energy", Math.round(energy));
        this.config.onEvent?.({ type: "input_audio_buffer.speech_started", direction: "server" });
      }
    }

    this.clearTimers();

    if (this.speechStarted && now - this.lastSpeechAt > this.providerConfig.silenceMs) {
      log("voice silence immediate", now - this.lastSpeechAt);
      this.finishTurn();
      return;
    }
    if (now - this.turnStartAt > this.providerConfig.maxTurnMs) {
      log("voice max turn");
      this.finishTurn();
      return;
    }

    this.silenceTimer = setTimeout(() => this.finishTurn(), this.providerConfig.silenceMs);
    this.turnTimer = setTimeout(() => this.finishTurn(), this.providerConfig.maxTurnMs - (now - this.turnStartAt));
  }

  computeEnergy(pcm16) {
    let sum = 0;
    const count = pcm16.length / 2;
    for (let i = 0; i < count; i++) {
      const s = pcm16.readInt16LE(i * 2);
      sum += s * s;
    }
    return Math.sqrt(sum / count);
  }

  async finishTurn() {
    this.clearTimers();
    if (this.responsePending || this.pcmBuffer.length === 0) {
      log("voice finishTurn skipped", { pending: this.responsePending, len: this.pcmBuffer.length });
      return;
    }
    const pcm = this.pcmBuffer;
    this.resetTurn();

    log("voice finishTurn", pcm.length);
    try {
      this.responsePending = true;
      let pcm16;
      if (this.audioFormat.encoding === "g711_ulaw") {
        pcm16 = await runFfmpeg(["-f", "s16le", "-ar", "8000", "-ac", "1"], ["-f", "s16le", "-ar", "16000", "-ac", "1"], pcm);
      } else {
        pcm16 = await runFfmpeg(["-f", "s16le", "-ar", "24000", "-ac", "1"], ["-f", "s16le", "-ar", "16000", "-ac", "1"], pcm);
      }

      const transcript = await whisperTranscribe(pcm16, this.providerConfig);
      log("voice user transcript", transcript);
      if (!transcript.trim()) {
        this.responsePending = false;
        return;
      }
      this.config.onTranscript?.("user", transcript, true);
      if (!this.useMainAgent) this.messages.push({ role: "user", content: transcript });
      await this.runResponse(transcript);
    } catch (error) {
      log("voice finishTurn error", error);
      this.responsePending = false;
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async runResponse(userTranscript) {
    this.responsePending = true;
    this.responseIsSpeaking = true;
    try {
      log("voice response start");
      this.config.onEvent?.({ type: "response.created", direction: "server" });
      let fullText;
      if (this.useMainAgent && this.gatewayClient) {
        fullText = await this.streamResponseFromMainAgent(userTranscript);
      } else {
        if (userTranscript) this.messages.push({ role: "user", content: userTranscript });
        fullText = await this.streamResponseFromOllama();
      }
      this.beginCooldown();
      if (!this.useMainAgent) this.messages.push({ role: "assistant", content: fullText });
      this.config.onTranscript?.("assistant", fullText, true);
      this.config.onEvent?.({ type: "response.done", direction: "server" });
      log("voice response done", fullText.slice(0, 80));
    } catch (error) {
      log("voice response error", error);
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.responsePending = false;
      this.totalAudioBytesSent = 0;
      this.responseIsSpeaking = false;
    }
  }

  submitToolResult() {
    // not supported in prototype
  }
}

function buildLocalRealtimeVoiceProvider() {
  return {
    id: "local",
    label: "Local Whisper + Kokoro",
    defaultModel: "local-realtime",
    autoSelectOrder: 1,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [G711_ULAW_8KHZ, PCM16_24KHZ],
      outputAudioFormats: [G711_ULAW_8KHZ, PCM16_24KHZ],
      supportsBrowserSession: false,
      supportsBargeIn: true,
      supportsToolCalls: false,
    },
    resolveConfig: ({ rawConfig }) => resolveConfig(rawConfig),
    isConfigured: () => true,
    createBridge: (req) => new LocalRealtimeVoiceBridge(req),
  };
}

function buildLocalRealtimeTranscriptionProvider() {
  return {
    id: "local",
    label: "Local Whisper Dictation",
    defaultModel: "local-whisper",
    autoSelectOrder: 1,
    resolveConfig: ({ rawConfig }) => resolveConfig(rawConfig),
    isConfigured: () => true,
    createSession: (req) => new LocalRealtimeTranscriptionSession(req),
  };
}

export default definePluginEntry({
  id: "local-realtime-voice",
  name: "Local Realtime Voice",
  description: "Local realtime voice and dictation using Whisper + Kokoro",
  register(api) {
    api.registerRealtimeVoiceProvider(buildLocalRealtimeVoiceProvider());
    api.registerRealtimeTranscriptionProvider(buildLocalRealtimeTranscriptionProvider());
  },
});
