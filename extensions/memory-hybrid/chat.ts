/**
 * Chat Model Module
 *
 * Calls LLM for intelligent memory operations:
 * - Knowledge graph extraction (parsing entities & relationships from text)
 * - Smart capture classification (deciding what to remember)
 * - Contradiction detection (comparing new facts with existing ones)
 *
 * Supports OpenAI and Google Gemini. Includes retry logic with exponential backoff.
 */

import OpenAI from "openai";

export type ChatProvider = "openai" | "google";

// Default chat models per provider (used for graph/capture, NOT for embedding)
export const DEFAULT_CHAT_MODELS: Record<string, string> = {
  google: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
};

export class ChatModel {
  private openai?: OpenAI;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly provider: ChatProvider,
  ) {
    if (this.provider === "openai") {
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Send a chat completion request to the LLM.
   * @param messages - Chat messages (role + content)
   * @param jsonMode - If true, request JSON output format
   * @returns The LLM response text
   */
  async complete(messages: { role: string; content: string }[], jsonMode = false): Promise<string> {
    return this.withRetry(() => {
      if (this.provider === "openai") {
        return this.completeOpenAI(messages, jsonMode);
      }
      return this.completeGoogle(messages, jsonMode);
    });
  }

  private async completeOpenAI(
    messages: { role: string; content: string }[],
    jsonMode: boolean,
  ): Promise<string> {
    const response = await this.openai!.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role as "user" | "system" | "assistant",
        content: m.content,
      })),
      temperature: 0.1,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
    return response.choices[0]?.message?.content ?? "";
  }

  private async completeGoogle(
    messages: { role: string; content: string }[],
    jsonMode: boolean,
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    // Convert chat messages to Gemini format
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };

    if (jsonMode) {
      body.generationConfig = {
        responseMimeType: "application/json",
        temperature: 0.1,
      };
    } else {
      body.generationConfig = { temperature: 0.1 };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Google Chat API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  /**
   * Check if a new memory contradicts an existing one.
   * used for "Self-Correcting Memory" (Project PHOENIX).
   */
  async checkForContradiction(
    oldMemory: string,
    newMemory: string,
  ): Promise<{
    contradiction: boolean;
    reason: string;
    action: "update" | "keep_both" | "ignore_new";
  }> {
    const prompt = `Analyze these two facts for contradictions.

OLD Fact: "${oldMemory.replace(/"/g, '\\"')}"
NEW Fact: "${newMemory.replace(/"/g, '\\"')}"

Determine the relationship:
1. CONTRADICTION: New fact makes old fact false (e.g., moved to new city, changed preference). Action: "update".
2. REFINEMENT: New fact adds detail to old fact without conflict. Action: "keep_both".
3. UNRELATED: Facts are about different things. Action: "keep_both".
4. DUPLICATE: New fact contains same info. Action: "ignore_new".

Return JSON:
{
  "contradiction": true/false,
  "reason": "short explanation",
  "action": "update" | "keep_both" | "ignore_new"
}`;

    try {
      const response = await this.complete(
        [{ role: "user", content: prompt }],
        true, // JSON mode
      );

      const cleanJson = response
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      return JSON.parse(cleanJson) as {
        contradiction: boolean;
        reason: string;
        action: "update" | "keep_both" | "ignore_new";
      };
    } catch (err) {
      // Fallback: assume no contradiction if LLM fails
      return { contradiction: false, reason: "LLM error", action: "keep_both" };
    }
  }

  /**
   * Retry with exponential backoff.
   * Handles 429 (rate limit) and 503 (overloaded) errors.
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isRetryable =
          lastError.message.includes("429") ||
          lastError.message.includes("503") ||
          lastError.message.includes("rate") ||
          lastError.message.includes("overloaded");

        if (!isRetryable || attempt === maxRetries) {
          throw lastError;
        }

        // Exponential backoff: 1s, 2s, 4s
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }
}
