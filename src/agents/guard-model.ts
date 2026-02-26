/**
 * Guard model — screens LLM output for safety before delivery.
 *
 * Calls a configurable guard/safety model (e.g. Qwen/QwenGuard on Chutes)
 * via an OpenAI-compatible chat completion API. The guard model evaluates
 * the assistant's reply and returns a structured verdict.
 *
 * Design decisions:
 *  - Fail-open by default (`onError: "allow"`) so guard API issues don't block users.
 *  - Short timeout (5 s) to minimise added latency.
 *  - Standalone HTTP call (no streaming) — guards don't need the full pi-ai session machinery.
 */

import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveApiKeyForProvider, type ResolvedProviderAuth } from "./model-auth.js";

const log = createSubsystemLogger("guard-model");

// ─── Types ──────────────────────────────────────────────────────────────────

export type GuardModelAction = "block" | "redact" | "warn";
export type GuardModelOnError = "allow" | "block";

export type GuardModelConfig = {
  provider: string;
  modelId: string;
  fallbacks?: Array<{ provider: string; modelId: string }>;
  action: GuardModelAction;
  onError: GuardModelOnError;
};

export type GuardResult = {
  safe: boolean;
  reason?: string;
  categories?: string[];
  source?: "classification" | "error";
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  isReasoning?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};

// ─── Known provider base URLs ───────────────────────────────────────────────

const KNOWN_BASE_URLS: Record<string, string> = {
  chutes: "https://chutes-api.erikbjare.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
};

// ─── Config resolution ──────────────────────────────────────────────────────

/**
 * Resolve guard model config from the OpenClaw config.
 * Returns null when no guard model is configured.
 */
export function resolveGuardModelConfig(cfg: OpenClawConfig | undefined): GuardModelConfig | null {
  if (!cfg) {
    return null;
  }

  const guardModelCfg = cfg.agents?.defaults?.guardModel;
  if (!guardModelCfg) {
    return null;
  }

  const primary = resolveAgentModelPrimaryValue(guardModelCfg);
  if (!primary) {
    return null;
  }

  // primary is "provider/model" — split on first "/"
  const slashIdx = primary.indexOf("/");
  if (slashIdx <= 0 || slashIdx >= primary.length - 1) {
    log.warn(`guard model config must use provider/model format: "${primary}"`);
    return null;
  }

  const provider = primary.slice(0, slashIdx);
  const modelId = primary.slice(slashIdx + 1);
  const fallbackRefs = resolveAgentModelFallbackValues(guardModelCfg);
  const seen = new Set<string>([`${provider}/${modelId}`]);
  const fallbacks: Array<{ provider: string; modelId: string }> = [];
  for (const fallbackRaw of fallbackRefs) {
    const parsed = parseGuardModelRef(fallbackRaw);
    if (!parsed) {
      continue;
    }
    const key = `${parsed.provider}/${parsed.modelId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fallbacks.push(parsed);
  }

  return {
    provider,
    modelId,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    action: cfg.agents?.defaults?.guardModelAction ?? "block",
    onError: cfg.agents?.defaults?.guardModelOnError ?? "allow",
  };
}

// ─── Guard evaluation ───────────────────────────────────────────────────────

const GUARD_SYSTEM_PROMPT = `You are a content safety classifier. Evaluate the following assistant reply for safety.
Respond ONLY with a JSON object: {"safe": true} or {"safe": false, "reason": "brief explanation", "categories": ["category1"]}
Do not include any other text.`;

const GUARD_TIMEOUT_MS = 5_000;

/**
 * Call the guard model to evaluate content safety.
 */
export async function evaluateGuard(
  content: string,
  config: GuardModelConfig,
  params?: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  },
): Promise<GuardResult> {
  let auth: ResolvedProviderAuth;
  try {
    auth = await resolveApiKeyForProvider({
      provider: config.provider,
      cfg: params?.cfg,
      agentDir: params?.agentDir,
    });
  } catch (err) {
    const authError = err instanceof Error ? err.message : String(err);
    log.warn(`guard model auth failed for provider "${config.provider}": ${authError}`);
    return handleGuardError(config, `auth error: ${authError}`);
  }

  const baseUrl =
    getCustomProviderBaseUrl(params?.cfg, config.provider) ??
    KNOWN_BASE_URLS[config.provider] ??
    `https://api.${config.provider}.com/v1`;

  const url = `${baseUrl}/chat/completions`;

  const body = JSON.stringify({
    model: config.modelId,
    messages: [
      { role: "system", content: GUARD_SYSTEM_PROMPT },
      { role: "user", content: `Evaluate this assistant reply:\n\n${content}` },
    ],
    max_tokens: 200,
    temperature: 0,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GUARD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        log.warn(`guard model API returned ${response.status}: ${errorText.slice(0, 200)}`);
        return handleGuardError(config, `HTTP ${response.status}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const replyText = json.choices?.[0]?.message?.content?.trim();
      if (!replyText) {
        log.warn("guard model returned empty response");
        return handleGuardError(config, "empty response");
      }

      return parseGuardResponse(replyText, config);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`guard model call failed: ${msg}`);
    return handleGuardError(config, msg);
  }
}

// ─── Response parsing ───────────────────────────────────────────────────────

function parseGuardResponse(raw: string, config: GuardModelConfig): GuardResult {
  // Try to extract the first complete JSON object from the response.
  // Guard models may wrap JSON in markdown or include extra text.
  const jsonContent = extractFirstJsonObject(raw);
  if (!jsonContent) {
    log.warn(`guard model did not return valid JSON: "${raw.slice(0, 200)}"`);
    return handleGuardError(config, "invalid JSON");
  }

  try {
    const parsed = JSON.parse(jsonContent) as {
      safe?: unknown;
      reason?: unknown;
      categories?: unknown;
    };
    if (typeof parsed.safe !== "boolean") {
      log.warn(`guard model returned non-boolean "safe" field: "${String(parsed.safe)}"`);
      return handleGuardError(config, 'invalid "safe" field');
    }
    return {
      safe: parsed.safe,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      categories: Array.isArray(parsed.categories)
        ? parsed.categories.filter((category): category is string => typeof category === "string")
        : undefined,
      source: "classification",
    };
  } catch {
    log.warn(`guard model JSON parse failed: "${raw.slice(0, 200)}"`);
    return handleGuardError(config, "JSON parse error");
  }
}

// ─── Error handling ─────────────────────────────────────────────────────────

function handleGuardError(config: GuardModelConfig, detail: string): GuardResult {
  if (config.onError === "block") {
    log.warn(`guard model error (fail-closed): ${detail}`);
    return { safe: false, reason: `Guard model error: ${detail}`, source: "error" };
  }
  // fail-open (default)
  log.debug(`guard model error (fail-open): ${detail}`);
  return { safe: true, source: "error" };
}

// ─── Payload screening ─────────────────────────────────────────────────────

const BLOCKED_MESSAGE = "⚠️ This response was blocked by the content safety guard.";
const REDACTED_MESSAGE = "⚠️ This response was redacted by the content safety guard.";
const GUARD_UNAVAILABLE_BLOCKED_MESSAGE =
  "⚠️ This response was blocked because the content safety guard is unavailable.";

function buildBlockedPayload(reason?: string): ReplyPayload[] {
  return [
    {
      text: BLOCKED_MESSAGE + (reason ? `\nReason: ${reason}` : ""),
      isError: true,
    },
  ];
}

function buildGuardErrorPayload(): ReplyPayload[] {
  return [
    {
      text: GUARD_UNAVAILABLE_BLOCKED_MESSAGE,
      isError: true,
    },
  ];
}

/**
 * Apply guard screening to outgoing payloads.
 * Returns modified payloads with unsafe content handled per the configured action.
 */
export async function applyGuardToPayloads(
  payloads: ReplyPayload[],
  config: GuardModelConfig,
  params?: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  },
): Promise<ReplyPayload[]> {
  // Collect all text content from payloads for a single guard evaluation
  const textParts = payloads
    .filter((p) => p.text && !p.isError && !p.isReasoning)
    .map((p) => p.text!);

  if (textParts.length === 0) {
    return payloads;
  }

  const combinedText = textParts.join("\n\n---\n\n");
  const result = await evaluateGuardWithFallbacks(combinedText, config, params);

  if (result.safe) {
    return payloads;
  }

  if (result.source === "error") {
    log.warn(`guard model error blocked response: ${result.reason ?? "unknown error"}`);
    return buildGuardErrorPayload();
  }

  log.info(
    `guard model flagged content as unsafe: ${result.reason ?? "no reason"}` +
      (result.categories?.length ? ` [${result.categories.join(", ")}]` : ""),
  );

  switch (config.action) {
    case "block":
      // Replace all non-error, non-reasoning payloads with a blocked message
      return buildBlockedPayload(result.reason);

    case "redact":
      // Replace text content but keep media/error payloads
      return payloads.map((p) => {
        if (p.text && !p.isError && !p.isReasoning) {
          return {
            ...p,
            text: REDACTED_MESSAGE + (result.reason ? `\nReason: ${result.reason}` : ""),
          };
        }
        return p;
      });

    case "warn":
      // Append a warning to the last text payload
      return [
        ...payloads,
        {
          text:
            `⚠️ Content safety warning: ${result.reason ?? "potential safety concern"}` +
            (result.categories?.length ? ` [${result.categories.join(", ")}]` : ""),
          isError: true,
        },
      ];

    default:
      return payloads;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractFirstJsonObject(raw: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!ch) {
      continue;
    }

    if (start < 0) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseGuardModelRef(raw: string): { provider: string; modelId: string } | null {
  const trimmed = raw.trim();
  const slashIdx = trimmed.indexOf("/");
  if (!trimmed || slashIdx <= 0 || slashIdx >= trimmed.length - 1) {
    log.warn(`guard model config must use provider/model format: "${raw}"`);
    return null;
  }
  return {
    provider: trimmed.slice(0, slashIdx),
    modelId: trimmed.slice(slashIdx + 1),
  };
}

async function evaluateGuardWithFallbacks(
  content: string,
  config: GuardModelConfig,
  params?: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  },
): Promise<GuardResult> {
  const candidates = [
    { provider: config.provider, modelId: config.modelId },
    ...(config.fallbacks ?? []),
  ];
  let lastError: GuardResult | null = null;

  for (const candidate of candidates) {
    const result = await evaluateGuard(content, { ...config, ...candidate }, params);
    if (result.source !== "error") {
      return result;
    }
    lastError = result;
  }

  return lastError ?? handleGuardError(config, "no guard model candidates configured");
}

function getCustomProviderBaseUrl(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const providers = cfg?.models?.providers ?? {};
  const entry = providers[provider];
  if (entry && typeof entry === "object" && "baseUrl" in entry) {
    return (entry as { baseUrl?: string }).baseUrl;
  }
  return undefined;
}
