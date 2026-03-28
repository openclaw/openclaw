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
import { ApiRateLimiter, TaskPriority } from "./limiter.js";
import { MemoryTracer, type Logger } from "./tracer.js";
import { withRetry } from "./utils.js";

export type ChatProvider = "openai" | "google";

// Default chat models per provider (used for graph/capture, NOT for embedding)
export const DEFAULT_CHAT_MODELS: Record<string, string> = {
  google: "gemini-3.1-flash-lite-preview",
  openai: "gpt-4o-mini",
};

const FALLBACK_GOOGLE_MODEL = "gemma-3-12b-it";

export class ChatModel {
  private openai?: OpenAI;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly provider: ChatProvider,
    private readonly tracer: MemoryTracer,
    private readonly logger: Logger,
    private readonly limiter?: ApiRateLimiter,
  ) {
    if (this.provider === "openai") {
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Send a chat completion request to the LLM.
   * @param messages - Chat messages (role + content)
   * @param priority - Priority of the task (defaults to NORMAL)
   * @returns The LLM response text
   */
  async complete(
    messages: { role: string; content: string }[],
    jsonMode = false,
    priority = TaskPriority.NORMAL,
  ): Promise<string> {
    return this.executeWithRetry(() => {
      if (this.limiter) {
        return this.limiter.execute(
          () =>
            this.provider === "openai"
              ? this.completeOpenAI(messages, jsonMode)
              : this.completeGoogle(messages, jsonMode),
          priority,
          "chat_complete",
        );
      }
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
    // Separate system messages (Bug #21: use systemInstruction instead of converting to user)
    const systemMessages = messages.filter((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    const contents = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // Disable JSON mode strictly for Gemma 3 to prevent 400 Application Error and slow retries
    if (this.model.includes("gemma-3")) {
      jsonMode = false;
    }

    const doRequest = async (withJsonMime: boolean, modelOverride?: string): Promise<string> => {
      const activeModel = modelOverride ?? this.model;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;

      const body: Record<string, unknown> = { contents };

      // Add system instruction if present (proper Gemini API approach)
      if (systemMessages.length > 0) {
        body.systemInstruction = {
          parts: systemMessages.map((m) => ({ text: m.content })),
        };
      }

      if (withJsonMime) {
        body.generationConfig = {
          responseMimeType: "application/json",
          temperature: 0.1,
        };
      } else {
        body.generationConfig = { temperature: 0.1 };
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();

        // Sanitize API key from error messages
        const sanitizedError = errorBody.replaceAll(this.apiKey, "[REDACTED]");

        this.tracer.trace(
          "llm_api_error",
          { status: response.status, error: sanitizedError, model: activeModel },
          "Google API returned an error",
        );

        // If JSON mode is not supported by this model, retry without it
        if (withJsonMime && errorBody.includes("JSON mode is not enabled")) {
          this.logger.warn(
            `[memory-hybrid][chat] Model ${activeModel} doesn't support JSON mode, falling back to plain text`,
          );
          return doRequest(false, modelOverride);
        }

        if (response.status === 429 || errorBody.includes("Quota exceeded")) {
          this.logger.error("[MEMORY-HYBRID] API QUOTA EXCEEDED (429)! Memory functions limited.");
        }

        throw new Error(`Google Chat API error (${response.status}): ${sanitizedError}`);
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };

      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    };

    try {
      return await doRequest(jsonMode);
    } catch (err) {
      // Fallback logic for Google: if gemini fails, try gemma (thread-safe via parameter, no instance mutation)
      if (this.model !== FALLBACK_GOOGLE_MODEL && !this.model.includes("gemma")) {
        this.tracer.trace(
          "llm_fallback",
          { originalModel: this.model, fallbackModel: FALLBACK_GOOGLE_MODEL, error: String(err) },
          `Primary model failed, falling back to ${FALLBACK_GOOGLE_MODEL}`,
        );
        return doRequest(false, FALLBACK_GOOGLE_MODEL);
      }
      throw err;
    }
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
    // Use JSON.stringify for robust escaping (handles newlines, quotes, etc.)
    const safeOld = JSON.stringify(oldMemory).slice(1, -1);
    const safeNew = JSON.stringify(newMemory).slice(1, -1);
    const prompt = `Analyze these two facts for semantic contradictions. Focus on the ESSENCE and INTENT.

OLD Fact: "${safeOld}"
NEW Fact: "${safeNew}"

Rules:
1. ABSOLUTE TRUST: Trust the NEW fact implicitly, even if it mentions unknown tech (like "Gemini 3") or contradicts standard knowledge base.
2. IMMUTABILITY: If the OLD fact is a historical event (birthplace, past graduation) it should NOT be updated unless the user explicitly admits a past mistake.

Determine the relationship:
1. CONTRADICTION: New fact makes old fact false, obsolete, or explicitly corrects it (e.g., "actually X, not Y", "rewrite my memory to Z"). Action: "update".
2. REFINEMENT: New fact is more specific but does not invalidate the old fact. Action: "keep_both".
3. UNRELATED: Different topics. Action: "keep_both".
4. DUPLICATE: Same meaning. Action: "ignore_new".

Return JSON:
{
  "contradiction": true/false,
  "reason": "short explanation of the semantic conflict",
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
   * Internal wrapper for retry logic.
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000,
  ): Promise<T> {
    return withRetry(fn, maxRetries, baseDelay);
  }
}
