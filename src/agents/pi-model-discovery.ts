import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";

export { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

/**
 * Convert an auth-profiles credential to the flat pi-sdk format.
 *
 * pi-sdk knows only "api_key" and "oauth"; OpenClaw's "token" type
 * maps to "api_key" with `key = token`.
 */
function toPiSdkCredential(cred: AuthProfileCredential): Record<string, unknown> | null {
  if (cred.type === "api_key") {
    return cred.key ? { type: "api_key", key: cred.key } : null;
  }
  if (cred.type === "token") {
    return cred.token ? { type: "api_key", key: cred.token } : null;
  }
  if (cred.type === "oauth") {
    if (!cred.access && !cred.refresh) {
      return null;
    }
    return {
      type: "oauth",
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
      ...(cred.projectId ? { projectId: cred.projectId } : {}),
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
    };
  }
  return null;
}

/**
 * Sync auth-profiles.json → auth.json so the pi-sdk's AuthStorage
 * can discover credentials configured via OpenClaw's profile system.
 *
 * OpenClaw stores credentials in auth-profiles.json with a nested format
 * (per-profile, with version/lastGood/usageStats), but the pi-sdk's
 * AuthStorage expects a flat Record<provider, credential> in auth.json.
 *
 * This bridge picks the best profile per provider (lastGood first, then
 * first available) and writes the flat format for pi-sdk consumption.
 */
function syncPiSdkAuthFile(agentDir: string): void {
  const store = ensureAuthProfileStore(agentDir);
  const flat: Record<string, Record<string, unknown>> = {};

  // Group profiles by provider
  const byProvider = new Map<string, Array<[string, AuthProfileCredential]>>();
  for (const [profileId, cred] of Object.entries(store.profiles)) {
    const entries = byProvider.get(cred.provider) ?? [];
    entries.push([profileId, cred]);
    byProvider.set(cred.provider, entries);
  }

  for (const [provider, profiles] of byProvider) {
    const lastGoodId = store.lastGood?.[provider];
    const match =
      (lastGoodId ? profiles.find(([id]) => id === lastGoodId) : undefined) ?? profiles[0];
    if (!match) {
      continue;
    }

    const converted = toPiSdkCredential(match[1]);
    if (converted) {
      flat[provider] = converted;
    }
  }

  const authJsonPath = path.join(agentDir, "auth.json");
  writeFileSync(authJsonPath, JSON.stringify(flat, null, 2), "utf-8");
  try {
    chmodSync(authJsonPath, 0o600);
  } catch {
    // chmod may fail on Windows — non-critical
  }
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): AuthStorage {
  syncPiSdkAuthFile(agentDir);
  return new AuthStorage(path.join(agentDir, "auth.json"));
}

export function discoverModels(authStorage: AuthStorage, agentDir: string): ModelRegistry {
  return new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
}
