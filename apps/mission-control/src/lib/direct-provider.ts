/**
 * Direct Provider — fallback module that makes AI API calls directly to
 * providers when the OpenClaw gateway is unreachable.
 *
 * Uses API keys stored in SQLite (via listApiKeys) and attempts providers
 * in preference order until one succeeds.
 */
import { listApiKeys } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectProviderResult {
    provider: string;
    response: Response; // raw fetch Response
}

// ---------------------------------------------------------------------------
// Provider endpoint map (chat completion URLs)
// ---------------------------------------------------------------------------

const PROVIDER_ENDPOINTS: Record<string, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    anthropic: "https://api.anthropic.com/v1/messages",
    // google: skipped — Gemini API format is different
    groq: "https://api.groq.com/openai/v1/chat/completions",
    mistral: "https://api.mistral.ai/v1/chat/completions",
    xai: "https://api.x.ai/v1/chat/completions",
    deepseek: "https://api.deepseek.com/v1/chat/completions",
    fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
    together: "https://api.together.xyz/v1/chat/completions",
    cerebras: "https://api.cerebras.ai/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    ollama: "http://localhost:11434/v1/chat/completions",
};

// ---------------------------------------------------------------------------
// Default model IDs per provider
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<string, string> = {
    openai: "gpt-4o",
    anthropic: "claude-sonnet-4-20250514",
    groq: "llama-3.3-70b-versatile",
    mistral: "mistral-large-latest",
    xai: "grok-3-mini",
    deepseek: "deepseek-chat",
    fireworks: "",
    together: "",
    cerebras: "",
    openrouter: "anthropic/claude-sonnet-4",
    ollama: "llama3.3",
};

// ---------------------------------------------------------------------------
// Request timeout (ms)
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Build a fetch request for a given provider
// ---------------------------------------------------------------------------

/**
 * Build the URL and RequestInit for a chat completion call to the given
 * provider. Most providers use the OpenAI-compatible format; Anthropic
 * requires a different body shape and auth headers.
 */
function buildRequest(
    provider: string,
    apiKey: string,
    messages: Array<{ role: string; content: string }>,
    model: string,
    temperature: number,
    maxTokens: number
): { url: string; init: RequestInit } {
    const url = PROVIDER_ENDPOINTS[provider];

    if (provider === "anthropic") {
        // Anthropic uses a different body format and auth mechanism.
        // The "system" message is extracted and passed as a top-level field;
        // remaining messages go into the messages array.
        const systemMsg = messages.find((m) => m.role === "system");
        const nonSystem = messages.filter((m) => m.role !== "system");

        const body: Record<string, unknown> = {
            model,
            messages: nonSystem,
            max_tokens: maxTokens,
            temperature,
        };
        if (systemMsg) {
            body.system = systemMsg.content;
        }

        return {
            url,
            init: {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(body),
            },
        };
    }

    // OpenAI-compatible format (used by most providers)
    const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
    };

    return {
        url,
        init: {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        },
    };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Attempt to send a chat completion request directly to a provider,
 * bypassing the gateway. Uses API keys stored in SQLite.
 *
 * Tries providers in preference order until one succeeds.
 */
export async function directChatCompletion(
    messages: Array<{ role: string; content: string }>,
    options?: {
        preferredProvider?: string;
        model?: string;
        temperature?: number;
        maxTokens?: number;
    }
): Promise<DirectProviderResult> {
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 2048;

    // Retrieve all active API keys from SQLite
    const allKeys = listApiKeys().filter((k) => k.is_active);

    if (allKeys.length === 0) {
        throw new Error(
            "[direct-provider] No active API keys found in the database."
        );
    }

    // Build provider order: preferred provider first (if it has an active key),
    // then the rest in the order they appear in the keys list.
    const preferred = options?.preferredProvider;
    const orderedKeys = [...allKeys];

    if (preferred) {
        const preferredIdx = orderedKeys.findIndex(
            (k) => k.provider === preferred
        );
        if (preferredIdx > 0) {
            const [key] = orderedKeys.splice(preferredIdx, 1);
            orderedKeys.unshift(key);
        }
    }

    // Track errors for the final summary
    const errors: Array<{ provider: string; error: string }> = [];

    for (const keyRecord of orderedKeys) {
        const { provider, api_key_encrypted: apiKey } = keyRecord;

        // Skip providers without a known endpoint
        if (!PROVIDER_ENDPOINTS[provider]) {
            continue;
        }

        // Resolve the model to use: explicit option > provider default
        const model =
            options?.model || PROVIDER_DEFAULTS[provider] || "default";

        try {
            const { url, init } = buildRequest(
                provider,
                apiKey,
                messages,
                model,
                temperature,
                maxTokens
            );

            // Apply a 30-second timeout via AbortController
            const controller = new AbortController();
            const timeout = setTimeout(
                () => controller.abort(),
                REQUEST_TIMEOUT_MS
            );

            const response = await fetch(url, {
                ...init,
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) {
                return { provider, response };
            }

            // Non-2xx — log and continue to the next provider
            const detail = await response.text().catch(() => "(no body)");
            const msg = `HTTP ${response.status}: ${detail.slice(0, 200)}`;
            console.warn(
                `[direct-provider] ${provider} returned ${msg}`
            );
            errors.push({ provider, error: msg });
        } catch (err) {
            const msg =
                err instanceof DOMException && err.name === "AbortError"
                    ? "Request timed out"
                    : String(err);
            console.warn(
                `[direct-provider] ${provider} failed:`,
                msg
            );
            errors.push({ provider, error: msg });
        }
    }

    // All providers failed
    const summary = errors
        .map((e) => `  ${e.provider}: ${e.error}`)
        .join("\n");
    throw new Error(
        `[direct-provider] All providers failed.\n${summary}`
    );
}

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

/**
 * Returns true if there is at least one active API key whose provider has a
 * known chat completion endpoint.
 */
export async function isDirectProviderAvailable(): Promise<boolean> {
    try {
        const keys = listApiKeys().filter((k) => k.is_active);
        return keys.some((k) => k.provider in PROVIDER_ENDPOINTS);
    } catch {
        return false;
    }
}
