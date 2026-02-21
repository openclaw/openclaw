import type { GuardianDecision, ResolvedGuardianModel } from "./types.js";

/**
 * Optional logger interface for debug logging.
 * When provided, the guardian client will log detailed information about
 * the request, response, and timing of each guardian LLM call.
 */
export type GuardianLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

/**
 * Parameters for a guardian LLM call.
 */
export type GuardianCallParams = {
  /** Resolved model info (baseUrl, apiKey, modelId, api type) */
  model: ResolvedGuardianModel;
  /** System prompt */
  systemPrompt: string;
  /** User prompt (tool call review request) */
  userPrompt: string;
  /** Timeout in ms */
  timeoutMs: number;
  /** Fallback policy on error */
  fallbackOnError: "allow" | "block";
  /** Optional logger for debug output */
  logger?: GuardianLogger;
};

/**
 * Call the guardian LLM to review a tool call.
 *
 * Uses the resolved model info (baseUrl, apiKey, api type) from OpenClaw's
 * model resolution pipeline. Supports:
 * - OpenAI-compatible APIs (covers OpenAI, Kimi/Moonshot, Ollama, DeepSeek, Groq, etc.)
 * - Anthropic Messages API
 * - Google Generative AI (Gemini) API
 *
 * On any error (network, timeout, parse), returns the configured fallback decision.
 */
export async function callGuardian(params: GuardianCallParams): Promise<GuardianDecision> {
  const { model, systemPrompt, userPrompt, timeoutMs, fallbackOnError, logger } = params;
  const fallback = makeFallbackDecision(fallbackOnError);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const startTime = Date.now();
  const api = model.api || "openai-completions";

  // Log the request details
  if (logger) {
    logger.info(
      `[guardian] ▶ Calling guardian LLM: provider=${model.provider}, model=${model.modelId}, ` +
        `api=${api}, baseUrl=${model.baseUrl}, timeout=${timeoutMs}ms`,
    );
    logger.info(
      `[guardian]   Prompt (user): ${userPrompt.slice(0, 500)}${userPrompt.length > 500 ? "..." : ""}`,
    );
  }

  try {
    let result: GuardianDecision;

    if (api === "anthropic-messages") {
      result = await callAnthropic(
        model,
        systemPrompt,
        userPrompt,
        controller.signal,
        fallback,
        logger,
      );
    } else if (api === "google-generative-ai") {
      result = await callGoogle(
        model,
        systemPrompt,
        userPrompt,
        controller.signal,
        fallback,
        logger,
      );
    } else {
      // Default: OpenAI-compatible API (covers openai-completions, openai-responses, ollama, etc.)
      result = await callOpenAICompat(
        model,
        systemPrompt,
        userPrompt,
        controller.signal,
        fallback,
        logger,
      );
    }

    const elapsed = Date.now() - startTime;
    if (logger) {
      logger.info(
        `[guardian] ◀ Guardian responded in ${elapsed}ms: action=${result.action.toUpperCase()}` +
          `${result.reason ? `, reason="${result.reason}"` : ""}`,
      );
    }

    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.includes("abort")) {
      const decision = {
        ...fallback,
        reason: `Guardian timed out after ${timeoutMs}ms: ${fallback.reason || "fallback"}`,
      };
      if (logger) {
        logger.warn(
          `[guardian] ◀ Guardian TIMED OUT after ${elapsed}ms — fallback=${fallback.action}`,
        );
      }
      return decision;
    }

    const decision = {
      ...fallback,
      reason: `Guardian error: ${errMsg}: ${fallback.reason || "fallback"}`,
    };
    if (logger) {
      logger.warn(
        `[guardian] ◀ Guardian ERROR after ${elapsed}ms: ${errMsg} — fallback=${fallback.action}`,
      );
    }
    return decision;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Provider-specific call implementations
// ---------------------------------------------------------------------------

/** Call an OpenAI-compatible chat completions endpoint. */
async function callOpenAICompat(
  model: ResolvedGuardianModel,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  fallback: GuardianDecision,
  logger?: GuardianLogger,
): Promise<GuardianDecision> {
  const url = `${model.baseUrl!.replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...model.headers,
  };
  if (model.apiKey) {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  if (logger) {
    logger.info(`[guardian]   Request URL: ${url}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 150,
      temperature: 0,
    }),
    signal,
  });

  if (!response.ok) {
    if (logger) {
      logger.warn(
        `[guardian]   HTTP error: status=${response.status}, statusText=${response.statusText}`,
      );
    }
    return {
      ...fallback,
      reason: `Guardian API returned HTTP ${response.status}: ${fallback.reason || "fallback"}`,
    };
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const content = data?.choices?.[0]?.message?.content?.trim();

  if (logger) {
    logger.info(`[guardian]   Raw response content: "${content || "(empty)"}"`);
  }

  if (!content) {
    return {
      ...fallback,
      reason: `Guardian returned empty response: ${fallback.reason || "fallback"}`,
    };
  }

  return parseGuardianResponse(content, fallback);
}

/** Call the Anthropic Messages API. */
async function callAnthropic(
  model: ResolvedGuardianModel,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  fallback: GuardianDecision,
  logger?: GuardianLogger,
): Promise<GuardianDecision> {
  const url = `${model.baseUrl!.replace(/\/+$/, "")}/v1/messages`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...model.headers,
  };
  if (model.apiKey) {
    if (model.authMode === "oauth" || model.authMode === "token") {
      // OAuth/token auth uses Authorization: Bearer header
      headers.Authorization = `Bearer ${model.apiKey}`;
      // Anthropic requires these beta flags for OAuth/token auth
      headers["anthropic-beta"] = "oauth-2025-04-20,claude-code-20250219";
    } else {
      // Default: direct API key uses x-api-key header
      headers["x-api-key"] = model.apiKey;
    }
  }

  if (logger) {
    logger.info(`[guardian]   Request URL: ${url}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.modelId,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: 150,
      temperature: 0,
    }),
    signal,
  });

  if (!response.ok) {
    if (logger) {
      logger.warn(
        `[guardian]   HTTP error: status=${response.status}, statusText=${response.statusText}`,
      );
    }
    return {
      ...fallback,
      reason: `Guardian Anthropic API returned HTTP ${response.status}: ${fallback.reason || "fallback"}`,
    };
  }

  const data = (await response.json()) as AnthropicResponse;
  const content = data?.content?.[0]?.text?.trim();

  if (logger) {
    logger.info(`[guardian]   Raw response content: "${content || "(empty)"}"`);
  }

  if (!content) {
    return {
      ...fallback,
      reason: `Guardian returned empty response: ${fallback.reason || "fallback"}`,
    };
  }

  return parseGuardianResponse(content, fallback);
}

/** Call the Google Generative AI (Gemini) API. */
async function callGoogle(
  model: ResolvedGuardianModel,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  fallback: GuardianDecision,
  logger?: GuardianLogger,
): Promise<GuardianDecision> {
  // Gemini endpoint: {baseUrl}/models/{model}:generateContent
  const baseUrl = model.baseUrl!.replace(/\/+$/, "");
  const url = `${baseUrl}/models/${model.modelId}:generateContent`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...model.headers,
  };
  if (model.apiKey) {
    headers["x-goog-api-key"] = model.apiKey;
  }

  if (logger) {
    logger.info(`[guardian]   Request URL: ${url}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 150,
        temperature: 0,
      },
    }),
    signal,
  });

  if (!response.ok) {
    if (logger) {
      logger.warn(
        `[guardian]   HTTP error: status=${response.status}, statusText=${response.statusText}`,
      );
    }
    return {
      ...fallback,
      reason: `Guardian Google API returned HTTP ${response.status}: ${fallback.reason || "fallback"}`,
    };
  }

  const data = (await response.json()) as GoogleGenerateResponse;
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (logger) {
    logger.info(`[guardian]   Raw response content: "${content || "(empty)"}"`);
  }

  if (!content) {
    return {
      ...fallback,
      reason: `Guardian returned empty response: ${fallback.reason || "fallback"}`,
    };
  }

  return parseGuardianResponse(content, fallback);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse the guardian LLM's response text into a decision. */
function parseGuardianResponse(content: string, fallback: GuardianDecision): GuardianDecision {
  const firstLine =
    content
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";

  if (firstLine.toUpperCase().startsWith("ALLOW")) {
    const colonIndex = firstLine.indexOf(":");
    const reason =
      colonIndex >= 0 ? firstLine.slice(colonIndex + 1).trim() : firstLine.slice(5).trim();
    return { action: "allow", reason: reason || undefined };
  }

  if (firstLine.toUpperCase().startsWith("BLOCK")) {
    const colonIndex = firstLine.indexOf(":");
    const reason =
      colonIndex >= 0 ? firstLine.slice(colonIndex + 1).trim() : firstLine.slice(5).trim();
    return { action: "block", reason: reason || "Blocked by guardian" };
  }

  return {
    ...fallback,
    reason: `Guardian response not recognized ("${firstLine.slice(0, 60)}"): ${fallback.reason || "fallback"}`,
  };
}

/** Build the fallback decision from config. */
function makeFallbackDecision(fallbackPolicy: "allow" | "block"): GuardianDecision {
  if (fallbackPolicy === "block") {
    return { action: "block", reason: "Guardian unavailable (fallback: block)" };
  }
  return { action: "allow", reason: "Guardian unavailable (fallback: allow)" };
}

/** Minimal type for OpenAI chat completions response. */
type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

/** Minimal type for Anthropic Messages response. */
type AnthropicResponse = {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

/** Minimal type for Google Generative AI (Gemini) response. */
type GoogleGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};
