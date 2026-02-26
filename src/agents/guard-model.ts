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
import type { ModelApi } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveApiKeyForProvider, type ResolvedProviderAuth } from "./model-auth.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./model-selection.js";
import { resolveModel } from "./pi-embedded-runner/model.js";

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
  maxInputChars?: number;
  compatibilityError?: string;
};

export type GuardResult = {
  safe: boolean;
  reason?: string;
  categories?: string[];
  source?: "classification" | "error";
  inputTruncated?: boolean;
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

const OPENAI_COMPATIBLE_GUARD_APIS = new Set<ModelApi>([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);
const NON_OPENAI_COMPATIBLE_GUARD_PROVIDERS = new Set([
  "anthropic",
  "google",
  "google-vertex",
  "google-gemini-cli",
  "amazon-bedrock",
  "ollama",
  "github-copilot",
]);

export type GuardModelCompatibility = {
  compatible: boolean;
  api?: string;
  reason?: string;
};

function resolveGuardModelCompatibility(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): GuardModelCompatibility {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (NON_OPENAI_COMPATIBLE_GUARD_PROVIDERS.has(normalizedProvider)) {
    return {
      compatible: false,
      reason: `provider "${params.provider}" is not OpenAI-compatible`,
    };
  }

  const providerCfg = findNormalizedProviderValue(params.cfg?.models?.providers, params.provider);
  const configuredApi =
    providerCfg && typeof providerCfg === "object" && "api" in providerCfg
      ? (providerCfg as { api?: string }).api
      : undefined;
  if (configuredApi && !OPENAI_COMPATIBLE_GUARD_APIS.has(configuredApi as ModelApi)) {
    return {
      compatible: false,
      api: configuredApi,
      reason: `provider API "${configuredApi}" is not OpenAI-compatible`,
    };
  }

  const resolved = resolveModel(params.provider, params.modelId, params.agentDir, params.cfg);
  if (!resolved.model) {
    // Unknown custom providers can still be OpenAI-compatible.
    // If we cannot positively identify a non-compatible API, allow the model ref.
    return { compatible: true };
  }

  const api = resolved.model.api;
  if (!OPENAI_COMPATIBLE_GUARD_APIS.has(api as ModelApi)) {
    return {
      compatible: false,
      api,
      reason: `API "${api}" is not OpenAI-compatible`,
    };
  }

  return { compatible: true, api };
}

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
  const maxInputChars = resolveGuardMaxInputChars(cfg.agents?.defaults?.guardModelMaxInputChars);
  const primaryCompatibility = resolveGuardModelCompatibility({ provider, modelId, cfg });
  if (!primaryCompatibility.compatible) {
    const compatibilityError = `Guard model "${primary}" is not compatible: ${primaryCompatibility.reason ?? "unsupported API"}`;
    log.warn(compatibilityError);
    return {
      provider,
      modelId,
      action: cfg.agents?.defaults?.guardModelAction ?? "block",
      onError: "block",
      ...(maxInputChars !== undefined ? { maxInputChars } : {}),
      compatibilityError,
    };
  }

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
    const fallbackCompatibility = resolveGuardModelCompatibility({
      provider: parsed.provider,
      modelId: parsed.modelId,
      cfg,
    });
    if (!fallbackCompatibility.compatible) {
      log.warn(
        `Skipping incompatible guard fallback "${key}": ${fallbackCompatibility.reason ?? "unsupported API"}`,
      );
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
    ...(maxInputChars !== undefined ? { maxInputChars } : {}),
  };
}

// ─── Guard evaluation ───────────────────────────────────────────────────────

const GUARD_SYSTEM_PROMPT = `You are a content safety classifier. Evaluate the following assistant reply for safety.
Respond ONLY with a JSON object: {"safe": true} or {"safe": false, "reason": "brief explanation", "categories": ["category1"]}
Do not include any other text.`;

const GUARD_TIMEOUT_MS = 5_000;
export const DEFAULT_GUARD_MAX_INPUT_CHARS = 32_000;
const GUARD_TRUNCATION_MARKER = "\n\n[truncated]";

function resolveGuardMaxInputChars(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : undefined;
}

function truncateGuardInput(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  if (maxChars <= GUARD_TRUNCATION_MARKER.length) {
    return {
      content: GUARD_TRUNCATION_MARKER.slice(0, maxChars),
      truncated: true,
    };
  }
  return {
    content: `${content.slice(0, maxChars - GUARD_TRUNCATION_MARKER.length)}${GUARD_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

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
  if (config.compatibilityError) {
    log.warn(`guard model compatibility error: ${config.compatibilityError}`);
    return handleGuardError({ ...config, onError: "block" }, config.compatibilityError);
  }

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
    resolveProviderBaseUrlFromRegistry(
      config.provider,
      config.modelId,
      params?.agentDir,
      params?.cfg,
    ) ??
    `https://api.${config.provider}.com/v1`;

  const maxInputChars =
    resolveGuardMaxInputChars(config.maxInputChars) ?? DEFAULT_GUARD_MAX_INPUT_CHARS;
  const guardInput = truncateGuardInput(content, maxInputChars);
  if (guardInput.truncated) {
    log.warn(`guard model input truncated from ${content.length} to ${guardInput.content.length}`);
  }

  const url = `${baseUrl}/chat/completions`;

  const body = JSON.stringify({
    model: config.modelId,
    messages: [
      { role: "system", content: GUARD_SYSTEM_PROMPT },
      { role: "user", content: `Evaluate this assistant reply:\n\n${guardInput.content}` },
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
        return {
          ...handleGuardError(config, `HTTP ${response.status}`),
          inputTruncated: guardInput.truncated,
        };
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const replyText = json.choices?.[0]?.message?.content?.trim();
      if (!replyText) {
        log.warn("guard model returned empty response");
        return {
          ...handleGuardError(config, "empty response"),
          inputTruncated: guardInput.truncated,
        };
      }

      return {
        ...parseGuardResponse(replyText, config),
        inputTruncated: guardInput.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`guard model call failed: ${msg}`);
    return {
      ...handleGuardError(config, msg),
      inputTruncated: guardInput.truncated,
    };
  }
}

// ─── Response parsing ───────────────────────────────────────────────────────

function parseGuardResponse(raw: string, config: GuardModelConfig): GuardResult {
  // Scan all JSON objects in the response and pick the first one that
  // contains a boolean `safe` verdict. Guard models may prepend metadata
  // objects before the actual verdict.
  const jsonObjects = extractJsonObjects(raw);
  if (jsonObjects.length === 0) {
    log.warn(`guard model did not return valid JSON: "${raw.slice(0, 200)}"`);
    return handleGuardError(config, "invalid JSON");
  }

  for (const jsonContent of jsonObjects) {
    try {
      const parsed = JSON.parse(jsonContent) as {
        safe?: unknown;
        reason?: unknown;
        categories?: unknown;
      };
      if (typeof parsed.safe !== "boolean") {
        continue;
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
      continue;
    }
  }

  log.warn(`guard model returned no verdict object with boolean "safe": "${raw.slice(0, 200)}"`);
  return handleGuardError(config, 'invalid "safe" field');
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
const GUARD_TRUNCATED_WARNING_PREFIX = "⚠️ Guard model input was truncated to ";

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

function buildGuardTruncationWarningText(maxChars: number): string {
  return `${GUARD_TRUNCATED_WARNING_PREFIX}${maxChars} characters before safety screening.`;
}

function annotateLastTextPayload(payloads: ReplyPayload[], suffix: string): ReplyPayload[] {
  const nextPayloads = payloads.slice();
  for (let i = nextPayloads.length - 1; i >= 0; i -= 1) {
    const payload = nextPayloads[i];
    if (!payload?.text) {
      continue;
    }
    nextPayloads[i] = {
      ...payload,
      text: `${payload.text}\n\n${suffix}`,
    };
    return nextPayloads;
  }
  return payloads;
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
  const maxInputChars =
    resolveGuardMaxInputChars(config.maxInputChars) ?? DEFAULT_GUARD_MAX_INPUT_CHARS;
  const shouldEmitTruncationWarning = Boolean(result.inputTruncated && config.onError === "allow");
  const truncationWarningText = buildGuardTruncationWarningText(maxInputChars);

  if (result.safe) {
    if (!shouldEmitTruncationWarning) {
      return payloads;
    }
    return annotateLastTextPayload(payloads, truncationWarningText);
  }

  if (result.source === "error") {
    log.warn(`guard model error blocked response: ${result.reason ?? "unknown error"}`);
    return buildGuardErrorPayload();
  }

  log.info(
    `guard model flagged content as unsafe: ${result.reason ?? "no reason"}` +
      (result.categories?.length ? ` [${result.categories.join(", ")}]` : ""),
  );

  const screenedPayloads = (() => {
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

      case "warn": {
        // Keep payload order stable for downstream delivery paths that pick
        // the last deliverable payload (for example isolated cron delivery).
        // Annotate the last user-facing text payload instead of appending one.
        const warningText =
          `⚠️ Content safety warning: ${result.reason ?? "potential safety concern"}` +
          (result.categories?.length ? ` [${result.categories.join(", ")}]` : "");
        const nextPayloads = payloads.slice();
        for (let i = nextPayloads.length - 1; i >= 0; i -= 1) {
          const payload = nextPayloads[i];
          if (!payload?.text || payload.isError || payload.isReasoning) {
            continue;
          }
          nextPayloads[i] = {
            ...payload,
            text: `${payload.text}\n\n${warningText}`,
          };
          return nextPayloads;
        }
        return payloads;
      }

      default:
        return payloads;
    }
  })();

  if (!shouldEmitTruncationWarning) {
    return screenedPayloads;
  }
  return annotateLastTextPayload(screenedPayloads, truncationWarningText);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractJsonObjects(raw: string): string[] {
  const objects: string[] = [];
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
        objects.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
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

export function resolveGuardModelRefCompatibility(
  modelRef: string,
  params?: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  },
): GuardModelCompatibility {
  const parsed = parseGuardModelRef(modelRef);
  if (!parsed) {
    return { compatible: false, reason: "Model reference must use provider/model format" };
  }
  return resolveGuardModelCompatibility({
    provider: parsed.provider,
    modelId: parsed.modelId,
    cfg: params?.cfg,
    agentDir: params?.agentDir,
  });
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
  const entry = findNormalizedProviderValue(cfg?.models?.providers, provider);
  if (entry && typeof entry === "object" && "baseUrl" in entry) {
    const url = (entry as { baseUrl?: string }).baseUrl;
    return typeof url === "string" && url.trim() ? url.trim() : undefined;
  }
  return undefined;
}

/**
 * Resolve the base URL for a provider from the model registry.
 * Falls back gracefully if the model isn't found or the registry can't be read.
 */
function resolveProviderBaseUrlFromRegistry(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
): string | undefined {
  try {
    const resolved = resolveModel(provider, modelId, agentDir, cfg);
    const url = resolved.model?.baseUrl;
    return typeof url === "string" && url.trim() ? url.trim() : undefined;
  } catch {
    return undefined;
  }
}
