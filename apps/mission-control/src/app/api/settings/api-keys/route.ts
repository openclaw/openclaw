import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  listApiKeys,
  getApiKey,
  createApiKey,
  updateApiKey,
  deleteApiKey,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { syncKeyToGateway, removeKeyFromGateway } from "@/lib/gateway-sync";

// --- Provider test endpoints ---

interface ProviderTestConfig {
  url: string;
  headers: (apiKey: string) => Record<string, string>;
  requiresBaseUrl?: boolean;
}

const PROVIDER_TEST_CONFIGS: Record<string, ProviderTestConfig> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1/models",
    headers: () => ({}),
  },
  "google-antigravity": {
    url: "https://generativelanguage.googleapis.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  ollama: {
    url: "http://localhost:11434/api/tags",
    headers: () => ({}),
  },
  groq: {
    url: "https://api.groq.com/openai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  mistral: {
    url: "https://api.mistral.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  deepseek: {
    url: "https://api.deepseek.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  fireworks: {
    url: "https://api.fireworks.ai/inference/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  together: {
    url: "https://api.together.xyz/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  cohere: {
    url: "https://api.cohere.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  perplexity: {
    url: "https://api.perplexity.ai/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  cerebras: {
    url: "https://api.cerebras.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  "azure-openai": {
    url: "",
    headers: (key) => ({ "api-key": key }),
    requiresBaseUrl: true,
  },
  huggingface: {
    url: "https://api-inference.huggingface.co/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  lmstudio: {
    url: "http://localhost:1234/v1/models",
    headers: () => ({}),
  },
};

async function testProviderConnection(
  provider: string,
  apiKey: string,
  baseUrl?: string | null
): Promise<{ ok: boolean; status: string; detail?: string }> {
  const config = PROVIDER_TEST_CONFIGS[provider];
  if (!config) {
    return { ok: true, status: "untested" };
  }

  // For providers that require a base_url (e.g. Azure OpenAI), fail early with a helpful message
  if (config.requiresBaseUrl && !baseUrl) {
    return {
      ok: false,
      status: "error",
      detail: `${provider} requires a base_url (e.g. https://YOUR-RESOURCE.openai.azure.com) to test the connection.`,
    };
  }

  try {
    let url = config.url;

    // For Azure OpenAI, build the test URL from the user-supplied base_url
    if (provider === "azure-openai" && baseUrl) {
      const base = baseUrl.replace(/\/+$/, "");
      url = `${base}/openai/models?api-version=2024-06-01`;
    }

    // For google, append key as query param
    if (provider === "google") {
      url = `${url}?key=${apiKey}`;
    }

    // For ollama, use custom base_url if provided
    if (provider === "ollama" && baseUrl) {
      url = `${baseUrl}/api/tags`;
    }

    // For providers with custom base_url, substitute
    if (baseUrl && provider !== "ollama" && provider !== "google" && provider !== "azure-openai") {
      const parsedBase = new URL(baseUrl);
      const parsedDefault = new URL(config.url);
      parsedBase.pathname = parsedDefault.pathname;
      url = parsedBase.toString();
    }

    const response = await fetch(url, {
      method: "GET",
      headers: config.headers(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { ok: true, status: "active" };
    }

    return {
      ok: false,
      status: "error",
      detail: `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Mask an API key, showing only the last 4 characters.
 */
function maskApiKey(encrypted: string): string {
  if (encrypted.length <= 4) {return "****";}
  return "****" + encrypted.slice(-4);
}

// GET /api/settings/api-keys -- list all keys (masked)
export const GET = withApiGuard(async () => {
  try {
    const keys = listApiKeys();
    const masked = keys.map((k) => ({
      ...k,
      api_key_encrypted: maskApiKey(k.api_key_encrypted),
    }));
    return NextResponse.json({ keys: masked });
  } catch (error) {
    return handleApiError(error, "Failed to list API keys");
  }
}, ApiGuardPresets.read);

// POST /api/settings/api-keys -- create new key
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const body = await request.json();

    const provider = body?.provider?.trim();
    const label = body?.label?.trim();
    const apiKeyValue = body?.api_key;
    const baseUrl = body?.base_url?.trim() || null;

    if (!provider) {throw new UserError("provider is required", 400);}
    if (!label) {throw new UserError("label is required", 400);}
    if (!apiKeyValue) {throw new UserError("api_key is required", 400);}

    const key = createApiKey({
      id: uuidv4(),
      provider,
      label,
      api_key_encrypted: apiKeyValue,
      base_url: baseUrl,
    });

    // Sync to gateway (non-fatal)
    syncKeyToGateway(provider, apiKeyValue, baseUrl).catch(() => {});

    return NextResponse.json(
      {
        ok: true,
        key: {
          ...key,
          api_key_encrypted: maskApiKey(key.api_key_encrypted),
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error, "Failed to create API key");
  }
}, ApiGuardPresets.write);

// PATCH /api/settings/api-keys -- update key or test connection
export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const id = body?.id;
    if (!id) {throw new UserError("id is required", 400);}

    const existing = getApiKey(id);
    if (!existing) {throw new UserError("API key not found", 404);}

    // If test=true, run a connection test
    if (body.test === true) {
      const result = await testProviderConnection(
        existing.provider,
        existing.api_key_encrypted,
        existing.base_url
      );

      const now = new Date().toISOString();
      updateApiKey(id, {
        last_tested_at: now,
        last_test_status: result.status,
      });

      const updated = getApiKey(id)!;
      return NextResponse.json({
        ok: true,
        testResult: result,
        key: {
          ...updated,
          api_key_encrypted: maskApiKey(updated.api_key_encrypted),
        },
      });
    }

    // Build patch from allowed fields
    const patch: Record<string, unknown> = {};
    if (body.label !== undefined) {patch.label = body.label.trim();}
    if (body.api_key !== undefined) {patch.api_key_encrypted = body.api_key;}
    if (body.base_url !== undefined) {patch.base_url = body.base_url?.trim() || null;}
    if (body.is_active !== undefined) {patch.is_active = body.is_active ? 1 : 0;}

    const updated = updateApiKey(id, patch as Parameters<typeof updateApiKey>[1]);
    if (!updated) {throw new UserError("API key not found", 404);}

    // If the API key value changed, sync to gateway
    if (body.api_key !== undefined) {
      syncKeyToGateway(updated.provider, body.api_key, updated.base_url).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      key: {
        ...updated,
        api_key_encrypted: maskApiKey(updated.api_key_encrypted),
      },
    });
  } catch (error) {
    return handleApiError(error, "Failed to update API key");
  }
}, ApiGuardPresets.write);

// DELETE /api/settings/api-keys -- delete key
export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {throw new UserError("id query param is required", 400);}

    const existing = getApiKey(id);
    if (!existing) {throw new UserError("API key not found", 404);}

    deleteApiKey(id);

    // Remove from gateway (non-fatal)
    removeKeyFromGateway(existing.provider).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete API key");
  }
}, ApiGuardPresets.write);
