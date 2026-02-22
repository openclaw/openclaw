import { NextResponse } from "next/server";
import { listApiKeys } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";

/**
 * GET /api/settings/api-keys/batch-status
 *
 * Returns all API keys grouped by provider with their status,
 * plus a list of providers that have no key configured.
 * Powers the AI API Command Center overview.
 */

const ALL_PROVIDERS = [
    "openai",
    "anthropic",
    "google",
    "google-antigravity",
    "xai",
    "openrouter",
    "groq",
    "mistral",
    "deepseek",
    "fireworks",
    "together",
    "cohere",
    "perplexity",
    "cerebras",
    "amazon-bedrock",
    "azure-openai",
    "github-copilot",
    "huggingface",
    "lmstudio",
    "ollama",
];

function maskApiKey(encrypted: string): string {
    if (encrypted.length <= 4) {return "****";}
    return "****" + encrypted.slice(-4);
}

export const GET = withApiGuard(async () => {
    try {
        const keys = listApiKeys();

        // Group keys by provider
        const byProvider: Record<
            string,
            Array<{
                id: string;
                provider: string;
                label: string;
                key_preview: string;
                base_url: string | null;
                is_active: boolean;
                last_tested_at: string | null;
                last_test_status: string | null;
                created_at: string;
            }>
        > = {};

        for (const key of keys) {
            const provider = key.provider;
            if (!byProvider[provider]) {byProvider[provider] = [];}
            byProvider[provider].push({
                id: key.id,
                provider: key.provider,
                label: key.label,
                key_preview: maskApiKey(key.api_key_encrypted),
                base_url: key.base_url,
                is_active: !!key.is_active,
                last_tested_at: key.last_tested_at,
                last_test_status: key.last_test_status,
                created_at: key.created_at,
            });
        }

        // Determine configured vs unconfigured providers
        const configuredProviders = Object.keys(byProvider);
        const unconfiguredProviders = ALL_PROVIDERS.filter(
            (p) => !configuredProviders.includes(p)
        );

        // Summary stats
        const totalKeys = keys.length;
        const activeKeys = keys.filter((k) => k.is_active).length;
        const testedKeys = keys.filter((k) => k.last_test_status === "active").length;
        const failedKeys = keys.filter(
            (k) => k.last_test_status === "error" || k.last_test_status === "failed"
        ).length;
        const untestedKeys = keys.filter((k) => !k.last_test_status).length;

        return NextResponse.json({
            byProvider,
            configuredProviders,
            unconfiguredProviders,
            allProviders: ALL_PROVIDERS,
            stats: {
                totalKeys,
                activeKeys,
                testedKeys,
                failedKeys,
                untestedKeys,
                totalProviders: ALL_PROVIDERS.length,
                configuredCount: configuredProviders.length,
            },
        });
    } catch (error) {
        return handleApiError(error, "Failed to get batch status");
    }
}, ApiGuardPresets.read);
