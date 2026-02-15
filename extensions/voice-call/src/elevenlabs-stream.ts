/**
 * ElevenLabs WebSocket Streaming TTS
 *
 * Streams text to ElevenLabs WebSocket API and returns ulaw_8000 audio chunks
 * that can be piped directly to Twilio Media Streams.
 *
 * Features:
 * - Persistent WebSocket connection pool (reused across TTS calls, 60s idle timeout)
 * - `ulaw_8000` output format — streams directly to Twilio without transcoding
 * - `auto_mode` for optimal chunking from ElevenLabs
 * - AbortSignal support for barge-in cancellation
 */

import WebSocket from "ws";

export interface ElevenLabsStreamConfig {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  baseUrl?: string;
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    speed?: number;
  };
}

export interface StreamingTtsResult {
  chunkCount: number;
  totalBytes: number;
  ttfbMs: number;
  totalMs: number;
}

// ── Persistent WebSocket connection pool ──
// Key: wsUrl, Value: { ws, ready, lastUsed, busy }
interface PoolEntry {
  ws: WebSocket;
  ready: boolean;
  lastUsed: number;
  busy: boolean;
}

const pool = new Map<string, PoolEntry>();

// Clean up idle connections after 60s
const POOL_IDLE_MS = 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (!entry.busy && now - entry.lastUsed > POOL_IDLE_MS) {
        try {
          entry.ws.close();
        } catch {
          /* ignore */
        }
        pool.delete(key);
      }
    }
    if (pool.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 15_000);
}

function buildWsUrl(config: ElevenLabsStreamConfig): string {
  const modelId = config.modelId ?? "eleven_flash_v2_5";
  const baseUrl = config.baseUrl ?? "wss://api.elevenlabs.io";
  return `${baseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/stream-input?model_id=${encodeURIComponent(modelId)}&output_format=ulaw_8000&auto_mode=true`;
}

function getOrCreateWs(
  config: ElevenLabsStreamConfig,
): Promise<{ ws: WebSocket; wsUrl: string; reused: boolean }> {
  const wsUrl = buildWsUrl(config);
  const existing = pool.get(wsUrl);

  if (existing && existing.ready && !existing.busy && existing.ws.readyState === WebSocket.OPEN) {
    existing.busy = true;
    existing.lastUsed = Date.now();
    return Promise.resolve({ ws: existing.ws, wsUrl, reused: true });
  }

  // Clean up stale entry
  if (existing) {
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
    pool.delete(wsUrl);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("ElevenLabs WebSocket connection timeout (5s)"));
    }, 5_000);

    ws.on("open", () => {
      clearTimeout(timeout);
      const entry: PoolEntry = { ws, ready: true, lastUsed: Date.now(), busy: true };
      pool.set(wsUrl, entry);
      startCleanup();
      resolve({ ws, wsUrl, reused: false });
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      pool.delete(wsUrl);
      reject(new Error(`ElevenLabs WebSocket connect error: ${err.message}`));
    });
  });
}

/**
 * Stream text to ElevenLabs and receive ulaw_8000 audio chunks via callback.
 *
 * The WebSocket connection is pooled and reused across calls. Audio chunks
 * arrive as base64-encoded mu-law 8kHz data that can be sent directly to
 * Twilio Media Streams without transcoding.
 *
 * @param text - Text to synthesize
 * @param config - ElevenLabs streaming configuration
 * @param onAudioChunk - Callback invoked with each base64 audio chunk
 * @param signal - Optional AbortSignal for barge-in cancellation
 */
export function streamTts(
  text: string,
  config: ElevenLabsStreamConfig,
  onAudioChunk: (base64Audio: string) => void,
  signal?: AbortSignal,
): Promise<StreamingTtsResult> {
  return new Promise<StreamingTtsResult>(async (resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted before start"));
      return;
    }

    const startTime = Date.now();
    let firstChunkTime = 0;
    let chunkCount = 0;
    let totalBytes = 0;
    let settled = false;
    let wsUrl = "";
    let ws: WebSocket | null = null;

    const TIMEOUT_MS = 30_000;
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        releaseWs();
        reject(new Error("ElevenLabs streaming TTS timed out (30s)"));
      }
    }, TIMEOUT_MS);

    function releaseWs() {
      clearTimeout(timeoutId);
      const entry = pool.get(wsUrl);
      if (entry) {
        entry.busy = false;
        entry.lastUsed = Date.now();
      }
    }

    function destroyWs() {
      clearTimeout(timeoutId);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      pool.delete(wsUrl);
      ws = null;
    }

    function onAbort() {
      if (!settled) {
        settled = true;
        destroyWs();
        reject(new Error("ElevenLabs streaming TTS aborted"));
      }
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const conn = await getOrCreateWs(config);
      ws = conn.ws;
      wsUrl = conn.wsUrl;
      const connectMs = Date.now() - startTime;
      console.debug(
        `[voice-call] ElevenLabs WebSocket ${conn.reused ? "reused" : "opened"} in ${connectMs}ms`,
      );

      // Helper to remove all listeners — prevents leaks on every settlement path
      const removeAllWsListeners = () => {
        ws!.removeListener("message", messageHandler);
        ws!.removeListener("error", errorHandler);
        ws!.removeListener("close", closeHandler);
      };

      // Set up message handler for THIS request
      const messageHandler = (data: WebSocket.Data) => {
        if (settled) return;

        try {
          const msg: any = JSON.parse(data.toString());

          if (msg.audio) {
            if (chunkCount === 0) {
              firstChunkTime = Date.now();
              console.debug(
                `[voice-call] ElevenLabs first audio chunk at ${firstChunkTime - startTime}ms`,
              );
            }
            chunkCount++;

            const padding = msg.audio.endsWith("==") ? 2 : msg.audio.endsWith("=") ? 1 : 0;
            const rawLen = Math.floor((msg.audio.length * 3) / 4) - padding;
            totalBytes += rawLen;

            onAudioChunk(msg.audio);
          }

          if (msg.isFinal) {
            settled = true;
            const totalMs = Date.now() - startTime;
            const ttfbMs = firstChunkTime ? firstChunkTime - startTime : totalMs;

            if (signal) signal.removeEventListener("abort", onAbort);
            removeAllWsListeners();

            // Don't close — return to pool
            releaseWs();

            console.debug(
              `[voice-call] ElevenLabs streaming complete: ${chunkCount} chunks, TTFB ${ttfbMs}ms, total ${totalMs}ms`,
            );
            resolve({ chunkCount, totalBytes, ttfbMs, totalMs });
          }

          if (msg.error) {
            settled = true;
            if (signal) signal.removeEventListener("abort", onAbort);
            removeAllWsListeners();
            destroyWs();
            reject(new Error(`ElevenLabs streaming error: ${msg.error}`));
          }
        } catch {
          // Ignore parse errors
        }
      };

      const errorHandler = (err: Error) => {
        if (!settled) {
          settled = true;
          if (signal) signal.removeEventListener("abort", onAbort);
          removeAllWsListeners();
          destroyWs();
          reject(new Error(`ElevenLabs WebSocket error: ${err.message}`));
        }
      };

      const closeHandler = () => {
        if (!settled) {
          settled = true;
          const totalMs = Date.now() - startTime;
          const ttfbMs = firstChunkTime ? firstChunkTime - startTime : totalMs;

          if (signal) signal.removeEventListener("abort", onAbort);
          removeAllWsListeners();
          pool.delete(wsUrl);

          if (chunkCount > 0) {
            resolve({ chunkCount, totalBytes, ttfbMs, totalMs });
          } else {
            reject(new Error("ElevenLabs WebSocket closed without sending audio"));
          }
        }
      };

      ws.on("message", messageHandler);
      ws.on("error", errorHandler);
      ws.on("close", closeHandler);

      // Send init message with API key and voice settings
      const initMsg: Record<string, unknown> = {
        text: " ",
        xi_api_key: config.apiKey,
      };

      if (config.voiceSettings) {
        const vs = config.voiceSettings;
        const voiceSettings: Record<string, unknown> = {
          stability: vs.stability ?? 0.5,
          similarity_boost: vs.similarityBoost ?? 0.75,
        };
        if (vs.style !== undefined) voiceSettings.style = vs.style;
        if (vs.useSpeakerBoost !== undefined) voiceSettings.use_speaker_boost = vs.useSpeakerBoost;
        if (vs.speed !== undefined) voiceSettings.speed = vs.speed;
        initMsg.voice_settings = voiceSettings;
      }

      ws.send(JSON.stringify(initMsg));

      // Send the full text
      ws.send(JSON.stringify({ text, try_trigger_generation: true }));

      // Send flush to signal end of input
      ws.send(JSON.stringify({ text: "", flush: true }));
    } catch (err: unknown) {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    }
  });
}
