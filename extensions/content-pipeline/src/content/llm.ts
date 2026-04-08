/**
 * Unified LLM client with multi-provider failover and auto key generation.
 *
 * Supports: Google AI Studio, Groq, OpenRouter, Cerebras, Anthropic.
 * On 429 rate limit: rotates keys → generates new keys → switches provider.
 *
 * Default: Google Gemini (free tier).
 * Failover chain: Google → Groq → Cerebras → OpenRouter → Anthropic
 */

import { KeyManager, type KeyManagerConfig } from "./key-manager.js";

export type Provider = "google" | "groq" | "openrouter" | "cerebras" | "anthropic" | "ollama";

export interface LlmConfig {
  provider: Provider;
  model: string;
}

export interface LlmMessage {
  system: string;
  prompt: string;
}

const PROVIDER_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  cerebras: "https://api.cerebras.ai/v1",
  ollama: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
};

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  google: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  ollama: ["OLLAMA_API_KEY"],
};

// Singleton KeyManager — initialized lazily
let _keyManager: KeyManager | null = null;

/** Initialize the KeyManager with auto key generation config */
export async function initKeyManager(config?: KeyManagerConfig): Promise<KeyManager> {
  if (!_keyManager) {
    _keyManager = new KeyManager(config ?? {});
    await _keyManager.initialize();
  }
  return _keyManager;
}

/** Parse model string like "google/gemma-4-27b" or "groq/llama-3.3-70b-versatile" */
export function parseModelSpec(model: string): LlmConfig {
  const slash = model.indexOf("/");
  if (slash === -1) {
    return { provider: "google", model };
  }
  const provider = model.slice(0, slash) as Provider;
  const modelName = model.slice(slash + 1);

  if (["google", "groq", "openrouter", "cerebras", "anthropic", "ollama"].includes(provider)) {
    return { provider, model: modelName };
  }
  return { provider: "google", model };
}

function getApiKey(provider: Provider): string | undefined {
  // Ollama doesn't require an API key by default (local server)
  if (provider === "ollama") {
    if (_keyManager) {
      const key = _keyManager.getActiveKey(provider);
      if (key) return key;
    }
    const envKeys = PROVIDER_ENV_KEYS[provider] ?? [];
    for (const key of envKeys) {
      if (process.env[key]) return process.env[key];
    }
    return "ollama"; // dummy key — Ollama ignores auth by default
  }

  // Try KeyManager first (has rotation + auto-generated keys)
  if (_keyManager) {
    const key = _keyManager.getActiveKey(provider);
    if (key) return key;
  }

  // Fallback to env vars
  const envKeys = PROVIDER_ENV_KEYS[provider] ?? [];
  for (const key of envKeys) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
}

function isRateLimitError(msg: string): boolean {
  return (
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("quota") ||
    msg.includes("Resource has been exhausted")
  );
}

/** Generate text with a single model (no failover) */
export async function generateText(config: LlmConfig, message: LlmMessage): Promise<string> {
  switch (config.provider) {
    case "google":
      return generateWithGoogle(config.model, message);
    case "anthropic":
      return generateWithAnthropic(config.model, message);
    case "groq":
    case "openrouter":
    case "cerebras":
    case "ollama":
      return generateWithOpenAICompat(config.provider, config.model, message);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Generate text with automatic failover + auto key generation.
 *
 * On 429: mark current key as exhausted → try next key from KeyManager
 * → if no keys left, try auto-generating a new key → if still fails, switch provider
 */
export async function generateTextWithFallback(
  models: string[],
  message: LlmMessage,
  keyManagerConfig?: KeyManagerConfig,
): Promise<string> {
  // Ensure KeyManager is initialized
  if (!_keyManager && keyManagerConfig) {
    await initKeyManager(keyManagerConfig);
  } else if (!_keyManager) {
    await initKeyManager();
  }

  const errors: string[] = [];

  for (const model of models) {
    const config = parseModelSpec(model);
    let apiKey = getApiKey(config.provider);

    if (!apiKey) {
      console.warn(`  ⏭ Skipping ${model}: no API key for ${config.provider}`);
      errors.push(`${model}: no API key`);
      continue;
    }

    // Try up to 3 times per model (with key rotation on 429)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await generateText(config, message);
        if (models.indexOf(model) > 0 || attempt > 0) {
          console.log(
            `  ✓ Succeeded with ${model}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`,
          );
        }
        return result;
      } catch (err) {
        const msg = (err as Error).message;

        if (isRateLimitError(msg) && _keyManager) {
          // Mark current key as exhausted
          _keyManager.markExhausted(config.provider, apiKey);
          console.warn(`  🔄 ${model}: rate limited, rotating key (attempt ${attempt + 1}/3)...`);

          // Get next key
          const nextKey = _keyManager.getActiveKey(config.provider);
          if (nextKey && nextKey !== apiKey) {
            apiKey = nextKey;
            // Update env so generateText picks up the new key
            const envKey = PROVIDER_ENV_KEYS[config.provider]?.[0];
            if (envKey) process.env[envKey] = nextKey;
            continue; // Retry with new key
          }

          // No more keys — try auto-generating one (Google only)
          if (config.provider === "google" && _keyManager.countAvailable("google") === 0) {
            console.warn(`  🔑 All Google keys exhausted, attempting auto-generation...`);
            try {
              await _keyManager.generateNewGoogleKey();
              const freshKey = _keyManager.getActiveKey("google");
              if (freshKey) {
                apiKey = freshKey;
                const envKey = PROVIDER_ENV_KEYS.google[0];
                if (envKey) process.env[envKey] = freshKey;
                console.log(`  🔑 New Google key generated, retrying...`);
                continue;
              }
            } catch (genErr) {
              console.warn(
                `  🔑 Auto key generation failed: ${(genErr as Error).message.slice(0, 80)}`,
              );
            }
          }

          // No more keys for this provider — move to next model
          break;
        }

        // Non-rate-limit error — move to next model
        console.warn(`  ⏭ ${model} failed: ${msg.slice(0, 100)}`);
        errors.push(`${model}: ${msg.slice(0, 80)}`);
        break;
      }
    }
  }

  throw new Error(`All models failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

// ── Google AI Studio (Gemini API) ──

async function generateWithGoogle(model: string, message: LlmMessage): Promise<string> {
  const apiKey = getApiKey("google");
  if (!apiKey) throw new Error("No Google AI API key. Set GOOGLE_AI_API_KEY or GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: message.system }] },
    contents: [{ role: "user", parts: [{ text: message.prompt }] }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google AI error (${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Google AI empty response: ${JSON.stringify(data).slice(0, 200)}`);
  return text;
}

// ── OpenAI-Compatible (Groq, OpenRouter, Cerebras) ──

async function generateWithOpenAICompat(
  provider: Provider,
  model: string,
  message: LlmMessage,
): Promise<string> {
  const apiKey = getApiKey(provider);
  if (!apiKey)
    throw new Error(`No API key for ${provider}. Set ${PROVIDER_ENV_KEYS[provider]?.[0]}`);

  const baseUrl = PROVIDER_URLS[provider];
  if (!baseUrl) throw new Error(`No API URL for provider: ${provider}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://openclaw.ai";
    headers["X-Title"] = "OpenClaw Content Pipeline";
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: message.system },
        { role: "user", content: message.prompt },
      ],
      max_tokens: 8192,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`${provider} error (${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider} empty response: ${JSON.stringify(data).slice(0, 200)}`);
  return text;
}

// ── Anthropic Claude ──

async function generateWithAnthropic(model: string, message: LlmMessage): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: message.system,
    messages: [{ role: "user", content: message.prompt }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

/** Strip markdown code fences from LLM output */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .split("\n")
      .slice(1)
      .join("\n")
      .replace(/```\s*$/, "")
      .trim();
  }
  return trimmed;
}
