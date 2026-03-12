#!/usr/bin/env npx tsx
/**
 * Probe Merlin model input token limits by sending progressively larger prompts.
 *
 * Usage:
 *   MERLIN_EMAIL=you@example.com MERLIN_PASSWORD=secret npx tsx scripts/probe-merlin-limits.ts
 *
 * Pass a model ID as argument to test only that model:
 *   npx tsx scripts/probe-merlin-limits.ts gemini-3.0-flash
 */

const FIREBASE_API_KEY = "AIzaSyAvCgtQ4XbmlQGIynDT-v_M8eLaXrKmtiM";
const FIREBASE_SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const MERLIN_API_BASE = "https://www.getmerlin.in/arcane/api";

const ALL_MODELS = [
  "gemini-3.0-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-lite",
  "gpt-5.2",
  "gpt-5-mini",
  "gpt-oss-120b",
  "grok-4.1-fast",
  "grok-4",
  "claude-4.6-opus",
  "kimi-k2.5-thinking",
  "minimax-m2.5",
  "glm-5",
];

async function login(email: string, password: string): Promise<string> {
  const resp = await fetch(FIREBASE_SIGN_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = (await resp.json()) as { idToken?: string; error?: { message: string } };
  if (data.error) {
    throw new Error(`Login failed: ${data.error.message}`);
  }
  return data.idToken!;
}

function buildTimestamp(): string {
  return new Date().toISOString().replace("Z", "+00:00[UTC]");
}

function generatePrompt(targetChars: number): string {
  const word = "apple ";
  const repeats = Math.ceil(targetChars / word.length);
  return `Respond with ONLY the number of times the word "apple" appears. Nothing else.\n\n${word.repeat(repeats)}`;
}

async function testModel(
  model: string,
  idToken: string,
  charCount: number,
): Promise<{ ok: boolean; error?: string; snippet?: string }> {
  const content = generatePrompt(charCount);

  const body = {
    attachments: [],
    chatId: crypto.randomUUID(),
    language: "AUTO",
    message: {
      id: crypto.randomUUID(),
      childId: crypto.randomUUID(),
      parentId: crypto.randomUUID(),
      content,
      context: "",
    },
    mode: "UNIFIED_CHAT",
    model,
    metadata: {
      noTask: true,
      isWebpageChat: false,
      deepResearch: false,
      webAccess: false,
      proFinderMode: false,
      mcpConfig: { isEnabled: false },
      merlinMagic: false,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetch(`${MERLIN_API_BASE}/v2/thread/unified`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-merlin-version": "web-merlin",
        "x-request-timestamp": buildTimestamp(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }

    if (!response.body) {
      return { ok: false, error: "Empty body" };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    let hadError = false;
    let errorMsg = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        let eventName = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventName = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }

        if (eventName === "error") {
          hadError = true;
          try {
            const errData = JSON.parse(data) as { message?: string; type?: string };
            errorMsg = `${errData.type}: ${errData.message}`;
          } catch {
            errorMsg = data;
          }
        }

        if (eventName === "message") {
          try {
            const msgData = JSON.parse(data) as {
              status?: string;
              data?: { type?: string; text?: string; eventType?: string };
            };
            if (
              msgData.status === "system" &&
              (msgData.data as Record<string, unknown>)?.eventType === "DONE"
            ) {
              reader.cancel().catch(() => {});
              break;
            }
            if (msgData.data?.type === "text" && msgData.data.text) {
              fullText += msgData.data.text;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    if (hadError && !fullText) {
      return { ok: false, error: errorMsg };
    }
    return { ok: true, snippet: fullText.slice(0, 100) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeModel(model: string, idToken: string): Promise<number> {
  // Character counts to test (~250, 1k, 4k, 8k, 16k, 32k, 64k, 128k tokens roughly)
  const charSizes = [1_000, 4_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000];
  let lastWorking = 0;

  for (const chars of charSizes) {
    const approxTokens = Math.round(chars / 4);
    process.stdout.write(`  ~${approxTokens} tokens (${chars} chars)... `);
    const result = await testModel(model, idToken, chars);
    if (result.ok) {
      console.log(`OK (${result.snippet?.slice(0, 40)})`);
      lastWorking = approxTokens;
    } else {
      console.log(`FAIL: ${result.error?.slice(0, 120)}`);
      break;
    }
    // Delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 2000));
  }

  return lastWorking;
}

async function main() {
  const email = process.env.MERLIN_EMAIL;
  const password = process.env.MERLIN_PASSWORD;
  if (!email || !password) {
    console.error("Set MERLIN_EMAIL and MERLIN_PASSWORD environment variables.");
    process.exit(1);
  }

  const targetModels = process.argv[2] ? [process.argv[2]] : ALL_MODELS;

  console.log("Logging in to Merlin...");
  const idToken = await login(email, password);
  console.log("Authenticated. Starting token limit probes...\n");

  const results: Record<string, number> = {};

  for (const model of targetModels) {
    console.log(`\n=== ${model} ===`);
    const maxTokens = await probeModel(model, idToken);
    results[model] = maxTokens;
    console.log(`  -> Max working: ~${maxTokens} tokens`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n\n========== RESULTS ==========");
  console.log("Update MERLIN context windows in src/agents/models-config.providers.static.ts:\n");
  for (const [model, tokens] of Object.entries(results)) {
    console.log(`${model.padEnd(25)} ~${tokens} tokens`);
  }
}

main().catch(console.error);
