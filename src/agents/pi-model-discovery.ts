import path from "node:path";
import {
  AuthStorage,
  InMemoryAuthStorageBackend,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import type { AuthProfileCredential } from "./auth-profiles.js";
import { normalizeProviderId } from "./model-selection.js";

export { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

type PiApiKeyCredential = { type: "api_key"; key: string };
type PiOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

type PiCredential = PiApiKeyCredential | PiOAuthCredential;
type PiCredentialMap = Record<string, PiCredential>;

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as AuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as AuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as AuthStorage & {
    setRuntimeApiKey?: (provider: string, apiKey: string) => void;
  };
  if (typeof withRuntimeOverride.setRuntimeApiKey === "function") {
    for (const [provider, credential] of Object.entries(creds)) {
      if (credential.type === "api_key") {
        withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
        continue;
      }
      withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
    }
  }
  return withRuntimeOverride;
}

function convertAuthProfileCredential(cred: AuthProfileCredential): PiCredential | null {
  if (cred.type === "api_key") {
    const key = typeof cred.key === "string" ? cred.key.trim() : "";
    if (!key) {
      return null;
    }
    return { type: "api_key", key };
  }

  if (cred.type === "token") {
    const token = typeof cred.token === "string" ? cred.token.trim() : "";
    if (!token) {
      return null;
    }
    if (
      typeof cred.expires === "number" &&
      Number.isFinite(cred.expires) &&
      Date.now() >= cred.expires
    ) {
      return null;
    }
    return { type: "api_key", key: token };
  }

  if (cred.type === "oauth") {
    const access = typeof cred.access === "string" ? cred.access.trim() : "";
    const refresh = typeof cred.refresh === "string" ? cred.refresh.trim() : "";
    if (!access || !refresh || !Number.isFinite(cred.expires) || cred.expires <= 0) {
      return null;
    }
    return {
      type: "oauth",
      access,
      refresh,
      expires: cred.expires,
    };
  }

  return null;
}

function resolvePiCredentials(agentDir: string): PiCredentialMap {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const credentials: PiCredentialMap = {};
  for (const credential of Object.values(store.profiles)) {
    const provider = normalizeProviderId(String(credential.provider ?? "")).trim();
    if (!provider || credentials[provider]) {
      continue;
    }
    const converted = convertAuthProfileCredential(credential);
    if (converted) {
      credentials[provider] = converted;
    }
  }
  return credentials;
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): AuthStorage {
  const credentials = resolvePiCredentials(agentDir);
  return createAuthStorage(AuthStorage, path.join(agentDir, "auth.json"), credentials);
}

export function discoverModels(authStorage: AuthStorage, agentDir: string): ModelRegistry {
  return new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
}
