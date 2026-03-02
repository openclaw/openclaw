/**
 * Brain Worker — SUPERSEDED as of v4.0
 *
 * In v4.0, server.js connects directly to the OpenClaw gateway
 * (ws://127.0.0.1:18789) and uses the `agent` RPC method to spawn
 * a Claude subagent. The gateway token is read from
 * ~/.openclaw/openclaw.json at startup.
 *
 * This file (and brain-bridge.js) are no longer started by the main
 * server. They are kept here as reference / fallback only.
 *
 * Original architecture (v3.x):
 *   Brain Bridge (port 8766) — brain-bridge.js
 *     ← GET /poll (this worker polls for think requests)
 *     → POST /respond (this worker sends back responses)
 *
 * Usage: node brain-worker.js
 * Requires: OPENAI_API_KEY in environment
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load environment ───────────────────────────────────────────

function loadEnv() {
  const secretsPath = resolve(__dirname, "../secrets/twilio.env");
  try {
    const content = readFileSync(secretsPath, "utf-8");
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
  } catch {}
}
loadEnv();

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:8766";
const POLL_TIMEOUT = 25000; // 25s long-poll

// ─── OpenAI Client ──────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are Clawd, David's AI assistant. You are currently in a PHONE CONVERSATION.

Rules for phone conversations:
- Keep responses concise and natural — aim for 1-3 sentences
- Do NOT use markdown, bullet points, URLs, code blocks, or anything that sounds awkward when spoken aloud
- Be warm, friendly, and conversational
- Sound natural — use contractions (I'm, you're, we'll) and casual speech patterns
- If you see [User interrupted you to say:], acknowledge it smoothly. Don't apologize excessively — just naturally respond to what they said.
- If you see [SYSTEM:], follow the instruction (e.g., greeting the caller)
- Remember: everything you say will be converted to speech by OpenAI TTS and played over the phone

You are helpful, knowledgeable, and have a warm personality. You know David well — he's a software developer interested in AI, trading, and building cool things.`;

// Conversation history (per-session, resets when worker restarts)
const conversationHistory = [];

async function think(userText) {
  // Handle system instructions
  if (userText.startsWith("[SYSTEM:")) {
    const instruction = userText.replace("[SYSTEM:", "").replace("]", "").trim();
    conversationHistory.push({ role: "user", content: `[System instruction: ${instruction}]` });
  } else {
    conversationHistory.push({ role: "user", content: userText });
  }

  // Keep history manageable (last 20 turns)
  while (conversationHistory.length > 40) {
    conversationHistory.shift();
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...conversationHistory],
      max_tokens: 200, // Keep responses short for voice
      temperature: 0.7,
    });

    const text = response.choices[0]?.message?.content || "I'm here, what's up?";
    conversationHistory.push({ role: "assistant", content: text });
    return text;
  } catch (err) {
    console.error("  ❌ OpenAI error:", err.message);
    return "I'm having a bit of trouble right now. Could you say that again?";
  }
}

// ─── Polling Loop ───────────────────────────────────────────────

async function poll() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT + 5000);

    const res = await fetch(`${BRIDGE_URL}/poll?timeout=${POLL_TIMEOUT}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 200) {
      const data = await res.json();
      if (data.requestId && data.text) {
        return data;
      }
    }
    // 204 or other = no request, return null
    return null;
  } catch (err) {
    if (err.name === "AbortError") {
      return null;
    }
    console.error("  ❌ Poll error:", err.message);
    // Wait before retrying on error
    await new Promise((r) => setTimeout(r, 2000));
    return null;
  }
}

async function respond(requestId, text) {
  try {
    await fetch(`${BRIDGE_URL}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, text }),
    });
  } catch (err) {
    console.error("  ❌ Respond error:", err.message);
  }
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║  🧠 Brain Worker v1.0                           ║
╠══════════════════════════════════════════════════╣
║  Bridge:  ${BRIDGE_URL}${" ".repeat(Math.max(0, 37 - BRIDGE_URL.length))}║
║  Model:   GPT-4o (OpenAI)                       ║
║  Mode:    Continuous polling                     ║
╚══════════════════════════════════════════════════╝
  `);

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set");
    process.exit(1);
  }
  console.log("✅ OpenAI API key loaded");
  console.log("🔄 Starting polling loop...\n");

  let requestCount = 0;

  while (true) {
    const request = await poll();

    if (request) {
      requestCount++;
      const { requestId, text } = request;
      console.log(`📥 [${requestCount}] Think: "${text}" [${requestId}]`);

      const t0 = Date.now();
      const response = await think(text);
      const elapsed = Date.now() - t0;

      console.log(
        `📤 [${requestCount}] Reply (${elapsed}ms): "${response.slice(0, 80)}${response.length > 80 ? "..." : ""}"`,
      );

      await respond(requestId, response);
    }
    // No request (204 or timeout) — immediately poll again
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
