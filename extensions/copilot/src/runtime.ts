import { resolve, sep } from "node:path";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { toStringifiedError as toCopilotRuntimeError } from "openclaw/plugin-sdk/error-runtime";
import { loadCopilotSdk } from "./sdk-loader.js";

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const POOL_DISPOSED_MESSAGE = "[copilot-pool] pool disposed";

export interface PoolKey {
  readonly agentId: string;
  readonly copilotHome: string;
  readonly authMode: "useLoggedInUser" | "gitHubToken" | "byok";
  readonly authProfileId?: string;
  readonly authProfileVersion?: string;
  /** Distinguishes hardened empty-mode clients from normal Copilot CLI clients. */
  readonly clientMode?: CopilotClientOptions["mode"];
}

export interface ClientCreateOptions extends Omit<
  CopilotClientOptions,
  "baseDirectory" | "workingDirectory" | "useLoggedInUser" | "gitHubToken"
> {
  readonly copilotHome: string;
  readonly useLoggedInUser?: boolean;
  readonly gitHubToken?: string;
}

export interface PooledClient {
  readonly key: PoolKey;
  readonly client: CopilotClient;
}

export interface CopilotClientPoolOptions {
  readonly sdkFactory?: (opts: CopilotClientOptions) => CopilotClient | Promise<CopilotClient>;
  readonly idleTtlMs?: number;
}

export type CopilotClientPool = ReturnType<typeof createCopilotClientPool>;

interface PoolEntry {
  readonly key: PoolKey;
  readonly cacheKey: string;
  readonly client: Promise<CopilotClient>;
  refCount: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<Error[]>;
}

export function createCopilotClientPool(options: CopilotClientPoolOptions = {}) {
  const sdkFactory =
    options.sdkFactory ??
    (async (clientOptions: CopilotClientOptions) => {
      // The loader reports install guidance when the optional SDK is missing.
      const sdk = await loadCopilotSdk();
      return new sdk.CopilotClient(clientOptions);
    });
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const entries = new Map<string, PoolEntry>();
  const releasedHandles = new WeakSet<PooledClient>();
  let disposePromise: Promise<Error[]> | undefined;

  const createDisposedError = () => new Error(POOL_DISPOSED_MESSAGE);

  const maybeDeleteEntry = (entry: PoolEntry) => {
    if (entries.get(entry.cacheKey) === entry) {
      entries.delete(entry.cacheKey);
    }
  };

  const stopEntry = (entry: PoolEntry): Promise<Error[]> => {
    if (entry.stopping) {
      return entry.stopping;
    }
    clearTimeout(entry.idleTimer);
    entry.stopping = (async () => {
      try {
        const client = await entry.client;
        return await client.stop();
      } catch (error: unknown) {
        return [toCopilotRuntimeError(error)];
      } finally {
        maybeDeleteEntry(entry);
      }
    })();
    return entry.stopping;
  };

  const createEntry = (key: PoolKey, cacheKey: string, clientOptions: CopilotClientOptions) => {
    // Register the entry before invoking a factory that may throw synchronously.
    const createPromise = Promise.resolve().then(async () => {
      try {
        return await sdkFactory(clientOptions);
      } catch (error: unknown) {
        maybeDeleteEntry(entry);
        throw toCopilotRuntimeError(error);
      }
    });
    const entry: PoolEntry = {
      key,
      cacheKey,
      refCount: 0,
      client: createPromise,
    };
    entries.set(cacheKey, entry);
    return entry;
  };

  const acquire = async (
    inputKey: PoolKey,
    optionsForCreate: ClientCreateOptions,
  ): Promise<PooledClient> => {
    const key = normalizePoolKey(inputKey, optionsForCreate.copilotHome, optionsForCreate.mode);
    const cacheKey = JSON.stringify(key);
    const clientOptions = normalizeClientCreateOptions(optionsForCreate, key.copilotHome);

    while (true) {
      if (disposePromise) {
        throw createDisposedError();
      }

      const entry = entries.get(cacheKey) ?? createEntry(key, cacheKey, clientOptions);
      if (entry.stopping) {
        await entry.stopping;
        continue;
      }
      clearTimeout(entry.idleTimer);
      entry.refCount += 1;
      const client = await entry.client;
      if (disposePromise) {
        await stopEntry(entry);
        throw createDisposedError();
      }
      return { key: entry.key, client };
    }
  };

  const release = async (handle: PooledClient): Promise<void> => {
    if (releasedHandles.has(handle)) {
      return;
    }
    releasedHandles.add(handle);

    const entry = entries.get(JSON.stringify(handle.key));
    if (!entry || entry.stopping || (await entry.client) !== handle.client) {
      return;
    }

    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }

    if (disposePromise) {
      await stopEntry(entry);
      return;
    }

    entry.idleTimer = setTimeout(() => {
      void stopEntry(entry);
    }, idleTtlMs);
  };

  const dispose = async (): Promise<Error[]> => {
    if (disposePromise) {
      await disposePromise;
      return [];
    }

    const snapshot = [...entries.values()];
    for (const entry of snapshot) {
      clearTimeout(entry.idleTimer);
    }

    disposePromise = (async () => {
      const errors: Error[] = [];
      for (const entry of snapshot) {
        const stopErrors = await stopEntry(entry);
        errors.push(...stopErrors);
      }
      entries.clear();
      return errors;
    })();

    return await disposePromise;
  };

  return {
    acquire,
    release,
    dispose,
    size: () => entries.size,
  };
}

function normalizePoolKey(
  key: PoolKey,
  rawCopilotHome: string,
  clientMode: CopilotClientOptions["mode"],
): PoolKey {
  return {
    agentId: key.agentId,
    copilotHome: normalizeCopilotHome(rawCopilotHome),
    authMode: key.authMode,
    authProfileId: key.authProfileId,
    authProfileVersion: key.authProfileVersion,
    // Undefined and `copilot-cli` are equivalent SDK defaults. Preserve the
    // existing cache identity while keeping empty-mode finalizers isolated.
    ...(clientMode === "empty" ? { clientMode } : {}),
  };
}

function normalizeClientCreateOptions(
  options: ClientCreateOptions,
  normalizedCopilotHome: string,
): CopilotClientOptions {
  const { copilotHome: _copilotHome, ...clientOptions } = options;
  return {
    ...clientOptions,
    baseDirectory: normalizedCopilotHome,
  };
}

function normalizeCopilotHome(copilotHome: string): string {
  let normalizedHome = resolve(copilotHome);
  if (normalizedHome.endsWith(sep) && normalizedHome.length > 1) {
    normalizedHome = normalizedHome.slice(0, -1);
  }
  if (process.platform === "win32") {
    normalizedHome = normalizedHome.toLowerCase();
  }
  return normalizedHome;
}
