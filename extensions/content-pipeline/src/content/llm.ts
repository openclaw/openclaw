/**
 * Unified LLM client — supports Google AI Studio (Gemma 4, Gemini) and Anthropic Claude.
 *
 * Default: Gemma 4 via Google AI Studio (free tier).
 * Set GOOGLE_AI_API_KEY in env. Get one at https://aistudio.google.com/apikey
 */

export interface LlmConfig {
  provider: "google" | "anthropic";
  model: string;
}

export interface LlmMessage {
  system: string;
  prompt: string;
}

/** Parse model string like "google/gemma-4-27b" or "anthropic/claude-sonnet-4-6" */
export function parseModelSpec(model: string): LlmConfig {
  if (model.startsWith("anthropic/")) {
    return { provider: "anthropic", model: model.replace("anthropic/", "") };
  }
  // Default: Google AI Studio
  return { provider: "google", model: model.replace("google/", "") };
}

export async function generateText(config: LlmConfig, message: LlmMessage): Promise<string> {
  if (config.provider === "anthropic") {
    return generateWithAnthropic(config.model, message);
  }
  return generateWithGoogle(config.model, message);
}

// ── Google AI Studio (Gemini API) ──

async function generateWithGoogle(model: string, message: LlmMessage): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_AI_API_KEY not set. Get one free at https://aistudio.google.com/apikey",
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: {
      parts: [{ text: message.system }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: message.prompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google AI API error (${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Google AI returned empty response: ${JSON.stringify(data)}`);
  }

  return text;
}

// ── Anthropic Claude ──

async function generateWithAnthropic(model: string, message: LlmMessage): Promise<string> {
  // Dynamic import so Anthropic SDK isn't required if using Google
  const { default: Anthropic } = await import("@anthropic-ai/sdk");

  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: message.system,
    messages: [{ role: "user", content: message.prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return text;
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
