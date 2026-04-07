/**
 * Unified LLM client with multi-provider failover.
 *
 * Supports: Google AI Studio, Groq, OpenRouter, Cerebras, Anthropic.
 * Auto-switches on rate limit (429) or error.
 *
 * Default: Google Gemini (free tier).
 * Failover chain: Google → Groq → OpenRouter → Cerebras → Anthropic
 */

export type Provider = "google" | "groq" | "openrouter" | "cerebras" | "anthropic";

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
};

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  google: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};

/** Parse model string like "google/gemma-4-27b" or "groq/llama-3.3-70b-versatile" */
export function parseModelSpec(model: string): LlmConfig {
  const slash = model.indexOf("/");
  if (slash === -1) {
    return { provider: "google", model };
  }
  const provider = model.slice(0, slash) as Provider;
  const modelName = model.slice(slash + 1);

  if (["google", "groq", "openrouter", "cerebras", "anthropic"].includes(provider)) {
    return { provider, model: modelName };
  }
  // Unknown prefix — treat as Google
  return { provider: "google", model };
}

function getApiKey(provider: Provider): string | undefined {
  const envKeys = PROVIDER_ENV_KEYS[provider] ?? [];
  for (const key of envKeys) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
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
      return generateWithOpenAICompat(config.provider, config.model, message);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/** Generate text with automatic failover across multiple models */
export async function generateTextWithFallback(
  models: string[],
  message: LlmMessage,
): Promise<string> {
  const errors: string[] = [];

  for (const model of models) {
    const config = parseModelSpec(model);
    const apiKey = getApiKey(config.provider);

    if (!apiKey) {
      console.warn(`  ⏭ Skipping ${model}: no API key for ${config.provider}`);
      errors.push(`${model}: no API key`);
      continue;
    }

    try {
      const result = await generateText(config, message);
      if (models.indexOf(model) > 0) {
        console.log(`  ✓ Succeeded with fallback model: ${model}`);
      }
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      const isRateLimit = msg.includes("429") || msg.includes("rate") || msg.includes("quota");
      console.warn(
        `  ⏭ ${model} failed${isRateLimit ? " (rate limited)" : ""}: ${msg.slice(0, 100)}`,
      );
      errors.push(`${model}: ${msg.slice(0, 80)}`);
    }
  }

  throw new Error(`All models failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

// ── Google AI Studio (Gemini API) ──

async function generateWithGoogle(model: string, message: LlmMessage): Promise<string> {
  const apiKey = getApiKey("google");
  if (!apiKey) {
    throw new Error("No Google AI API key. Set GOOGLE_AI_API_KEY or GEMINI_API_KEY");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: message.system }] },
    contents: [{ role: "user", parts: [{ text: message.prompt }] }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
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

  // OpenRouter requires extra headers
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
      max_tokens: 4096,
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
