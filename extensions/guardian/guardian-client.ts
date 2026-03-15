import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Model, TextContent, ThinkingContent } from "@mariozechner/pi-ai";
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

    // Race condition guard: the abort signal may have fired just as
    // completeSimple() returned, producing empty/truncated content instead
    // of throwing. Detect this and treat as a proper timeout.
    if (controller.signal.aborted) {
      const elapsed = Date.now() - startTime;
      const decision = {
        ...fallback,
        reason: `Guardian timed out after ${timeoutMs}ms: ${fallback.reason || "fallback"}`,
      };
      if (logger) {
        logger.warn(
          `[guardian] ◀ Guardian TIMED OUT after ${elapsed}ms (abort race) — fallback=${fallback.action}`,
        );
      }
      return decision;
    }

    // Extract text content from AssistantMessage.
    // Some reasoning models (e.g. kimi-coding) return thinking blocks
    // instead of text blocks — fall back to those if no text found.
    const content = extractResponseText(res.content, logger);

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

    if (errMsg.includes("abort") || controller.signal.aborted) {
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
 * Extract text from an assistant response's content blocks.
 *
 * Primary: `text` blocks (standard response format).
 * Fallback: `thinking` blocks — some reasoning models (e.g. kimi-coding)
 * return their answer in thinking blocks instead of text blocks.
 *
 * Logs block types when the response is empty or falls back to thinking,
 * to aid debugging provider-specific behavior.
 */
function extractResponseText(
  contentBlocks: (TextContent | ThinkingContent | { type: string })[],
  logger?: GuardianLogger,
): string {
  // Try text blocks first (preferred)
  const textContent = contentBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (textContent) {
    return textContent;
  }

  // Fallback: extract from thinking blocks (reasoning models)
  const thinkingContent = contentBlocks
    .filter((block): block is ThinkingContent => block.type === "thinking")
    .map((block) => block.thinking.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (thinkingContent) {
    if (logger) {
      logger.info(`[guardian] No text blocks in response — extracted from thinking blocks instead`);
    }
    return thinkingContent;
  }

  // Neither text nor thinking blocks had content
  if (logger) {
    const types = contentBlocks.map((b) => b.type).join(", ");
    logger.warn(`[guardian] Empty response — block types received: [${types || "none"}]`);
  }
  return "";
}

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

    // Require a delimiter after ALLOW/BLOCK to avoid matching words like
    // "ALLOWING" or "BLOCKED" which are not valid verdicts.
    if (upper === "ALLOW" || upper.startsWith("ALLOW:") || upper.startsWith("ALLOW ")) {
      const colonIndex = line.indexOf(":");
      const reason = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : line.slice(5).trim();
      return { action: "allow", reason: reason || undefined };
    }

    if (upper === "BLOCK" || upper.startsWith("BLOCK:") || upper.startsWith("BLOCK ")) {
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

// ---------------------------------------------------------------------------
// Raw text completion — used for summary generation
// ---------------------------------------------------------------------------

/**
 * Parameters for a raw text completion call.
 */
export type TextCallParams = {
  model: ResolvedGuardianModel;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
  logger?: GuardianLogger;
};

/**
 * Call the guardian's LLM and return raw text output.
 *
 * Unlike `callGuardian()`, this does NOT parse ALLOW/BLOCK — it returns
 * the raw text response. Used for summary generation.
 *
 * Returns undefined on error/timeout.
 */
export async function callForText(params: TextCallParams): Promise<string | undefined> {
  const { model, systemPrompt, userPrompt, timeoutMs, logger } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
        maxTokens: 200,
        temperature: 0,
        signal: controller.signal,
      },
    );

    // Abort race guard (same as callGuardian)
    if (controller.signal.aborted) {
      if (logger) {
        logger.warn(`[guardian] Summary call timed out after ${timeoutMs}ms (abort race)`);
      }
      return undefined;
    }

    const content = extractResponseText(res.content, logger);

    if (logger) {
      logger.info(
        `[guardian] Summary response: "${content.slice(0, 200)}${content.length > 200 ? "..." : ""}"`,
      );
    }

    return content || undefined;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (logger) {
      logger.warn(`[guardian] Summary call failed: ${errMsg}`);
    }
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}
