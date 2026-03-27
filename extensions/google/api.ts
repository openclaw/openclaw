import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "openclaw/plugin-sdk/provider-stream";

export { createGoogleThinkingPayloadWrapper, sanitizeGoogleThinkingPayload };

export function normalizeGoogleModelId(id: string): string {
  if (id === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  if (id === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  if (id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemini-3.1-flash-lite") {
    return "gemini-3.1-flash-lite-preview";
  }
  if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  return id;
}

const DEFAULT_GOOGLE_API_HOST = "generativelanguage.googleapis.com";

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(baseUrl?.trim() || DEFAULT_GOOGLE_API_BASE_URL);
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    if (
      url.hostname.toLowerCase() === DEFAULT_GOOGLE_API_HOST &&
      trimTrailingSlashes(url.pathname || "") === ""
    ) {
      url.pathname = "/v1beta";
    }
    return trimTrailingSlashes(url.toString());
  } catch {
    if (/^https:\/\/generativelanguage\.googleapis\.com\/?$/i.test(raw)) {
      return DEFAULT_GOOGLE_API_BASE_URL;
    }
    return raw;
  }
}

export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  if (apiKey.startsWith("{")) {
    try {
      const parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          headers: {
            Authorization: `Bearer ${parsed.token}`,
            "Content-Type": "application/json",
          },
        };
      }
    } catch {
      // Fall back to API key mode.
    }
  }

  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}

export const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";

export function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = cfg.agents?.defaults?.model as unknown;
  const currentPrimary =
    typeof current === "string"
      ? current.trim() || undefined
      : current &&
          typeof current === "object" &&
          typeof (current as { primary?: unknown }).primary === "string"
        ? ((current as { primary: string }).primary || "").trim() || undefined
        : undefined;
  if (currentPrimary === GOOGLE_GEMINI_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, GOOGLE_GEMINI_DEFAULT_MODEL),
    changed: true,
  };
}
