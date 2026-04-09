/**
 * Voice line health monitoring — periodic component checks with ntfy alerts.
 * Checks Telnyx, Cartesia (+ Edge fallback), Deepgram, and Anthropic every interval.
 * Pushes ntfy notification on failure so a dead phone line gets caught fast.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VOICE_DEBUG_ENABLED = !!process.env.VOICE_DEBUG;
const VOICE_DEBUG_LOG = VOICE_DEBUG_ENABLED
  ? path.join(os.homedir(), ".openclaw", "voice-debug.log")
  : null;
function voiceDebug(msg: string): void {
  if (!VOICE_DEBUG_ENABLED) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (VOICE_DEBUG_LOG) {
    try { fs.appendFileSync(VOICE_DEBUG_LOG, line); } catch { /* ignore */ }
  }
  console.log(`[voice-debug] ${msg}`);
}

export type ComponentStatus = {
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
};

export type HealthSnapshot = {
  ok: boolean;
  timestamp: string;
  components: ComponentStatus[];
  lastSuccessfulCall?: string;
};

type HealthMonitorConfig = {
  telnyxApiKey: string;
  cartesiaApiKey?: string;
  cartesiaVoiceId?: string;
  cartesiaModelId?: string;
  deepgramApiKey?: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  ntfyTopic?: string;
  intervalMs: number;
};

// Track last known state to avoid alert spam
let lastHealthOk = true;
let consecutiveFailures = 0;
let healthInterval: ReturnType<typeof setInterval> | null = null;

// Track last successful inbound call (updated from webhook.ts)
let lastSuccessfulCallTime: string | null = null;

export function recordSuccessfulCall(): void {
  lastSuccessfulCallTime = new Date().toISOString();
}

/** Check Telnyx API reachability */
async function checkTelnyx(apiKey: string): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const resp = await fetch("https://api.telnyx.com/v2/phone_numbers?page[size]=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { name: "telnyx", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "telnyx", ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

/** Check Cartesia TTS (tiny synthesis) */
async function checkCartesia(apiKey: string, modelId: string, voiceId: string): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: modelId,
        transcript: "OK",
        voice: { mode: "id", id: voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 8000 },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // Consume body to complete the request
    await resp.arrayBuffer();
    return { name: "cartesia", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "cartesia", ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

/** Check Edge TTS fallback availability */
async function checkEdgeTts(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const { edgeTtsFallback } = await import("./edge-tts-fallback.js");
    const result = await edgeTtsFallback("OK", "en-US-AvaNeural", 10000);
    if (!result.audio || result.audio.length === 0) throw new Error("Empty audio");
    return { name: "edge-tts", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "edge-tts", ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

/** Check Deepgram API reachability */
async function checkDeepgram(apiKey: string): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const resp = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { name: "deepgram", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "deepgram", ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

/** Check Anthropic API reachability */
async function checkAnthropic(apiKey: string, baseUrl: string): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const normalizedBase = baseUrl.replace(/\/v1\/?$/, "");
    const resp = await fetch(`${normalizedBase}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // Consume body
    await resp.json();
    return { name: "anthropic", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "anthropic", ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

/** Send ntfy push notification */
async function sendNtfyAlert(topic: string, title: string, message: string, priority: number): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: String(priority),
        Tags: priority >= 4 ? "rotating_light,phone" : "white_check_mark,phone",
      },
      body: message,
      signal: AbortSignal.timeout(5000),
    });
    voiceDebug(`[health] ntfy alert sent: ${title}`);
  } catch (err) {
    voiceDebug(`[health] ntfy send failed: ${err}`);
  }
}

/** Run all health checks and return a snapshot. */
export async function runHealthCheck(config: HealthMonitorConfig): Promise<HealthSnapshot> {
  const checks: Promise<ComponentStatus>[] = [];

  // Always check Telnyx (core telephony)
  checks.push(checkTelnyx(config.telnyxApiKey));

  // Check Cartesia if configured
  if (config.cartesiaApiKey && config.cartesiaVoiceId && config.cartesiaModelId) {
    checks.push(checkCartesia(config.cartesiaApiKey, config.cartesiaModelId, config.cartesiaVoiceId));
  }

  // Always check Edge TTS (free fallback)
  checks.push(checkEdgeTts());

  // Check Deepgram if configured
  if (config.deepgramApiKey) {
    checks.push(checkDeepgram(config.deepgramApiKey));
  }

  // Check Anthropic if configured
  if (config.anthropicApiKey) {
    checks.push(checkAnthropic(
      config.anthropicApiKey,
      config.anthropicBaseUrl || "https://api.anthropic.com",
    ));
  }

  const components = await Promise.all(checks);

  // Voice line is OK if Telnyx + at least one TTS + Deepgram + Anthropic are up
  const telnyx = components.find((c) => c.name === "telnyx");
  const cartesia = components.find((c) => c.name === "cartesia");
  const edge = components.find((c) => c.name === "edge-tts");
  const deepgram = components.find((c) => c.name === "deepgram");
  const anthropic = components.find((c) => c.name === "anthropic");

  const ttsOk = (cartesia?.ok ?? false) || (edge?.ok ?? false);
  const allCriticalOk = (telnyx?.ok ?? false) && ttsOk && (deepgram?.ok ?? true) && (anthropic?.ok ?? true);

  return {
    ok: allCriticalOk,
    timestamp: new Date().toISOString(),
    components,
    lastSuccessfulCall: lastSuccessfulCallTime ?? undefined,
  };
}

/** Start the periodic health monitor. */
export function startHealthMonitor(config: HealthMonitorConfig): void {
  if (healthInterval) {
    clearInterval(healthInterval);
  }

  voiceDebug(`[health] Starting health monitor (interval: ${config.intervalMs / 1000}s, ntfy: ${config.ntfyTopic || "disabled"})`);

  const runCheck = async () => {
    const snapshot = await runHealthCheck(config);
    const failedComponents = snapshot.components.filter((c) => !c.ok);

    if (snapshot.ok) {
      if (!lastHealthOk && config.ntfyTopic) {
        // Recovery — send all-clear
        await sendNtfyAlert(
          config.ntfyTopic,
          "Voice Line Recovered",
          `All components healthy. Was down for ${consecutiveFailures} check(s).`,
          2,
        );
      }
      lastHealthOk = true;
      consecutiveFailures = 0;
      voiceDebug(`[health] OK — all components healthy (${snapshot.components.map((c) => `${c.name}:${c.latencyMs}ms`).join(", ")})`);
    } else {
      consecutiveFailures++;
      const failMsg = failedComponents.map((c) => `${c.name}: ${c.error}`).join("\n");

      voiceDebug(`[health] FAIL #${consecutiveFailures} — ${failedComponents.length} component(s) down:\n${failMsg}`);

      // Alert on first failure and every 3rd consecutive failure after that
      if (config.ntfyTopic && (consecutiveFailures === 1 || consecutiveFailures % 3 === 0)) {
        await sendNtfyAlert(
          config.ntfyTopic,
          `Voice Line DOWN (${consecutiveFailures}x)`,
          `Failed components:\n${failMsg}\n\nLast good call: ${snapshot.lastSuccessfulCall || "unknown"}`,
          consecutiveFailures >= 3 ? 5 : 4, // urgent after 3 failures
        );
      }

      lastHealthOk = false;
    }
  };

  // Run first check after a short delay (let gateway fully initialize)
  setTimeout(() => {
    void runCheck();
    healthInterval = setInterval(() => void runCheck(), config.intervalMs);
  }, 30000);
}

/** Stop the health monitor. */
export function stopHealthMonitor(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
    voiceDebug(`[health] Stopped`);
  }
}
