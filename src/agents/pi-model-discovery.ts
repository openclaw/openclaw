import fs from "node:fs";
import path from "node:path";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";

const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;

export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

function createInMemoryAuthStorageBackend(
  initialData: PiCredentialMap,
): InMemoryAuthStorageBackendLike {
  let snapshot = JSON.stringify(initialData, null, 2);
  return {
    withLock<T>(
      update: (current: string) => {
        result: T;
        next?: string;
      },
    ): T {
      const { result, next } = update(snapshot);
      if (typeof next === "string") {
        snapshot = next;
      }
      return result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubLegacyStaticAuthJsonEntries(pathname: string): void {
  if (process.env.OPENCLAW_AUTH_STORE_READONLY === "1") {
    return;
  }
  if (!fs.existsSync(pathname)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  let changed = false;
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type !== "api_key") {
      continue;
    }
    delete parsed[provider];
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (Object.keys(parsed).length === 0) {
    fs.rmSync(pathname, { force: true });
    return;
  }

  fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = (
      PiCodingAgent as { InMemoryAuthStorageBackend?: new () => InMemoryAuthStorageBackendLike }
    ).InMemoryAuthStorageBackend;
    const backend =
      typeof backendCtor === "function"
        ? new backendCtor()
        : createInMemoryAuthStorageBackend(creds);
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as PiAuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as PiAuthStorage & {
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

function resolvePiCredentials(agentDir: string): PiCredentialMap {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  return resolvePiCredentialMapFromStore(store);
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): PiAuthStorage {
  const credentials = resolvePiCredentials(agentDir);
  const authPath = path.join(agentDir, "auth.json");
  scrubLegacyStaticAuthJsonEntries(authPath);
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

export function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry {
  return new PiModelRegistryClass(authStorage, path.join(agentDir, "models.json"));
}
