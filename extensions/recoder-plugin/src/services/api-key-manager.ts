/**
 * Recoder API Key Manager
 *
 * Handles automatic API key generation and management for OpenClaw users.
 * Each OpenClaw user gets a unique Recoder API key that's stored in Recoder's database.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import type {
  RecoderPluginConfig,
  OpenClawApiKey,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
} from "../types/index.js";

// Use docker backend for API key management (api.recoder.xyz doesn't have these endpoints)
const DEFAULT_DOCKER_URL = "https://docker.recoder.xyz";
const CREDENTIALS_DIR = path.join(os.homedir(), ".openclaw", "credentials");
const API_KEYS_FILE = path.join(CREDENTIALS_DIR, "recoder-api-keys.json");

// Local cache of API keys by OpenClaw user ID
interface ApiKeyCache {
  keys: Record<string, { apiKey: string; keyInfo: OpenClawApiKey }>;
  lastUpdated: number;
}

let cachedKeys: ApiKeyCache | null = null;

/**
 * Load cached API keys from disk
 */
async function loadCachedKeys(): Promise<ApiKeyCache> {
  if (cachedKeys) {
    return cachedKeys;
  }

  try {
    await fs.mkdir(CREDENTIALS_DIR, { recursive: true });
    const content = await fs.readFile(API_KEYS_FILE, "utf-8");
    cachedKeys = JSON.parse(content) as ApiKeyCache;
    return cachedKeys;
  } catch {
    cachedKeys = { keys: {}, lastUpdated: Date.now() };
    return cachedKeys;
  }
}

/**
 * Save API keys cache to disk
 */
async function saveCachedKeys(cache: ApiKeyCache): Promise<void> {
  cache.lastUpdated = Date.now();
  cachedKeys = cache;

  try {
    await fs.mkdir(CREDENTIALS_DIR, { recursive: true });
    await fs.writeFile(API_KEYS_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.warn("[recoder-plugin] Failed to save API key cache:", err);
  }
}

/**
 * Generate a unique API key prefix for identification
 */
function generateKeyPrefix(): string {
  const random = crypto.randomBytes(4).toString("hex");
  return `sk_oc_${random}`;
}

/**
 * Generate a full API key
 */
function generateApiKey(): string {
  const prefix = generateKeyPrefix();
  const secret = crypto.randomBytes(24).toString("base64url");
  return `${prefix}_${secret}`;
}

/**
 * Hash an API key for storage
 */
function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Get or create an API key for an OpenClaw user
 */
export async function getOrCreateApiKey(
  config: RecoderPluginConfig,
  openclawUserId: string,
  openclawChannel: string,
): Promise<{ apiKey: string; keyInfo: OpenClawApiKey; isNew: boolean }> {
  const cache = await loadCachedKeys();
  const cacheKey = `${openclawChannel}:${openclawUserId}`;

  // Check local cache first
  if (cache.keys[cacheKey]) {
    const cached = cache.keys[cacheKey];

    // Verify key is still valid with API
    try {
      const isValid = await verifyApiKey(config, cached.apiKey);
      if (isValid) {
        return { ...cached, isNew: false };
      }
    } catch {
      // Key may be invalid, regenerate
    }
  }

  // Create new API key via Recoder API
  const newKey = await createApiKeyViaApi(config, {
    openclawUserId,
    openclawChannel,
    scopes: [
      "sandboxes:read",
      "sandboxes:write",
      "projects:read",
      "projects:write",
      "files:read",
      "files:write",
      "execute:commands",
    ],
    metadata: {
      source: "openclaw-plugin",
      createdAt: new Date().toISOString(),
    },
  });

  // Cache the new key
  cache.keys[cacheKey] = newKey;
  await saveCachedKeys(cache);

  return { ...newKey, isNew: true };
}

/**
 * Create API key via Recoder API
 */
async function createApiKeyViaApi(
  config: RecoderPluginConfig,
  request: CreateApiKeyRequest,
): Promise<{ apiKey: string; keyInfo: OpenClawApiKey }> {
  const dockerUrl = config.dockerUrl ?? DEFAULT_DOCKER_URL;

  // For now, generate locally and register with Recoder API
  // In production, this would call Recoder's API to create and store the key
  const apiKey = generateApiKey();
  const keyPrefix = apiKey.split("_").slice(0, 3).join("_");

  const keyInfo: OpenClawApiKey = {
    id: crypto.randomUUID(),
    keyPrefix,
    openclawUserId: request.openclawUserId,
    openclawChannel: request.openclawChannel,
    scopes: request.scopes ?? [],
    tier: "developer",
    isActive: true,
    createdAt: Date.now(),
    metadata: request.metadata,
  };

  // Register with Recoder Docker Backend
  try {
    const response = await fetch(`${dockerUrl}/api/v1/api-keys/openclaw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth needed for initial key registration (unauthenticated endpoint)
      },
      body: JSON.stringify({
        openclawUserId: request.openclawUserId,
        openclawChannel: request.openclawChannel,
        scopes: request.scopes,
        metadata: request.metadata,
      }),
    });

    if (response.ok) {
      const result = await response.json() as {
        data?: { apiKey?: string; keyId?: string; keyPrefix?: string; isNew?: boolean };
      };

      if (result.data?.apiKey) {
        // Server generated the key
        return {
          apiKey: result.data.apiKey,
          keyInfo: {
            ...keyInfo,
            id: result.data.keyId || keyInfo.id,
            keyPrefix: result.data.keyPrefix || keyPrefix,
          },
        };
      }
    } else {
      const errorText = await response.text().catch(() => "");
      console.warn(`[recoder-plugin] API key registration returned ${response.status}: ${errorText}`);
    }
  } catch (err) {
    console.warn("[recoder-plugin] Failed to register API key with Recoder:", err);
  }

  // Return locally generated key if server registration failed
  return { apiKey, keyInfo };
}

/**
 * Verify an API key is valid
 */
async function verifyApiKey(config: RecoderPluginConfig, apiKey: string): Promise<boolean> {
  const dockerUrl = config.dockerUrl ?? DEFAULT_DOCKER_URL;

  try {
    const response = await fetch(`${dockerUrl}/api/v1/api-keys/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(
  config: RecoderPluginConfig,
  apiKey: string,
): Promise<boolean> {
  const dockerUrl = config.dockerUrl ?? DEFAULT_DOCKER_URL;

  try {
    const response = await fetch(`${dockerUrl}/api/v1/api-keys/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
    });

    if (response.ok) {
      // Remove from local cache
      const cache = await loadCachedKeys();
      for (const [key, value] of Object.entries(cache.keys)) {
        if (value.apiKey === apiKey) {
          delete cache.keys[key];
          break;
        }
      }
      await saveCachedKeys(cache);
    }

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get API key for current context
 * Falls back to config.apiKey if no user-specific key exists
 */
export async function getApiKeyForContext(
  config: RecoderPluginConfig,
  context: { openclawUserId?: string; openclawChannel?: string },
): Promise<string | undefined> {
  // If user context is available, get or create a user-specific key
  if (context.openclawUserId && context.openclawChannel) {
    try {
      const { apiKey } = await getOrCreateApiKey(
        config,
        context.openclawUserId,
        context.openclawChannel,
      );
      return apiKey;
    } catch (err) {
      console.warn("[recoder-plugin] Failed to get user API key:", err);
    }
  }

  // Fall back to config API key
  return config.apiKey;
}

/**
 * Clear all cached API keys
 */
export async function clearApiKeyCache(): Promise<void> {
  cachedKeys = { keys: {}, lastUpdated: Date.now() };
  try {
    await fs.unlink(API_KEYS_FILE);
  } catch {
    // File may not exist
  }
}
