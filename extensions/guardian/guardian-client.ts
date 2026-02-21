import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Model, TextContent } from "@mariozechner/pi-ai";
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

// ---------------------------------------------------------------------------
// Model conversion — ResolvedGuardianModel → pi-ai Model<Api>
// ---------------------------------------------------------------------------

/**
 * Convert a ResolvedGuardianModel to pi-ai's Model<Api> type.
 *
 * The guardian only needs short text responses, so we use sensible defaults
 * for fields like reasoning, cost, contextWindow, etc.
 */
function toModelSpec(resolved: ResolvedGuardianModel): Model<Api> {
  return {
    id: resolved.modelId,
    name: resolved.modelId,
    api: (resolved.api || "openai-completions") as Api,
    provider: resolved.provider,
    baseUrl: resolved.baseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    headers: resolved.headers,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Call the guardian LLM to review a tool call.
 *
 * Uses pi-ai's `completeSimple()` to call the model — the same SDK-level
 * HTTP stack that the main OpenClaw agent uses. This ensures consistent
 * behavior (User-Agent headers, auth handling, retry logic, etc.) across
 * all providers.
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
    const modelSpec = toModelSpec(model);

    const res = await completeSimple(
      modelSpec,
      {
        systemPrompt,
        messages: [
          {
            role: "user" as const,
            content: userPrompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: model.apiKey,
        maxTokens: 150,
        temperature: 0,
        signal: controller.signal,
      },
    );

    // Extract text content from AssistantMessage
    const content = res.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    if (logger) {
      logger.info(`[guardian]   Raw response content: "${content || "(empty)"}"`);
    }

    if (!content) {
      const decision = {
        ...fallback,
        reason: `Guardian returned empty response: ${fallback.reason || "fallback"}`,
      };
      if (logger) {
        logger.warn(`[guardian] ◀ Guardian returned empty response — fallback=${fallback.action}`);
      }
      return decision;
    }

    const result = parseGuardianResponse(content, fallback);

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
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Parse the guardian LLM's response text into a decision.
 *
 * Scans from the FIRST line forward to find the verdict. The prompt strictly
 * requires a single-line response starting with ALLOW or BLOCK, so the first
 * matching line is the intended verdict.
 *
 * Forward scanning is also more secure: if an attacker embeds "ALLOW: ..."
 * in tool arguments and the model echoes it, it would appear AFTER the
 * model's own verdict. Scanning forward ensures the model's output takes
 * priority over any attacker-injected text.
 */
function parseGuardianResponse(content: string, fallback: GuardianDecision): GuardianDecision {
  const lines = content.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();

    if (upper.startsWith("ALLOW")) {
      const colonIndex = line.indexOf(":");
      const reason = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : line.slice(5).trim();
      return { action: "allow", reason: reason || undefined };
    }

    if (upper.startsWith("BLOCK")) {
      const colonIndex = line.indexOf(":");
      const reason = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : line.slice(5).trim();
      return { action: "block", reason: reason || "Blocked by guardian" };
    }
  }

  return {
    ...fallback,
    reason: `Guardian response not recognized ("${content.trim().slice(0, 60)}"): ${fallback.reason || "fallback"}`,
  };
}

/** Build the fallback decision from config. */
function makeFallbackDecision(fallbackPolicy: "allow" | "block"): GuardianDecision {
  if (fallbackPolicy === "block") {
    return { action: "block", reason: "Guardian unavailable (fallback: block)" };
  }
  return { action: "allow", reason: "Guardian unavailable (fallback: allow)" };
}
