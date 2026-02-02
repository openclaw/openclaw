import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { LogService } from "@vector-im/matrix-bot-sdk";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "./types.js";
import { resolveMatrixAuth } from "./config.js";
import { createMatrixClient } from "./create-client.js";
import { DEFAULT_ACCOUNT_KEY } from "./storage.js";

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
};

// Support multiple accounts with separate clients
const sharedClientStates = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();
const sharedClientStartPromises = new Map<string, Promise<void>>();

function buildSharedClientKey(auth: MatrixAuth, accountId?: string | null): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    accountId ?? DEFAULT_ACCOUNT_KEY,
  ].join("|");
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
  accountId?: string | null;
}): Promise<SharedMatrixClientState> {
  const client = await createMatrixClient({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    encryption: params.auth.encryption,
    localTimeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  return {
    client,
    key: buildSharedClientKey(params.auth, params.accountId),
    started: false,
    cryptoReady: false,
  };
}

async function ensureSharedClientStarted(params: {
  state: SharedMatrixClientState;
  timeoutMs?: number;
  initialSyncLimit?: number;
  encryption?: boolean;
}): Promise<void> {
  if (params.state.started) {
    return;
  }
  const key = params.state.key;
  const existingStartPromise = sharedClientStartPromises.get(key);
  if (existingStartPromise) {
    await existingStartPromise;
    return;
  }
  const startPromise = (async () => {
    const client = params.state.client;

    // Initialize crypto if enabled
    if (params.encryption && !params.state.cryptoReady) {
      try {
        const joinedRooms = await client.getJoinedRooms();
        if (client.crypto) {
          await (client.crypto as { prepare: (rooms?: string[]) => Promise<void> }).prepare(
            joinedRooms,
          );
          params.state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await client.start();
    params.state.started = true;
  })();
  sharedClientStartPromises.set(key, startPromise);
  try {
    await startPromise;
  } finally {
    sharedClientStartPromises.delete(key);
  }
}

export async function resolveSharedMatrixClient(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
  } = {},
): Promise<MatrixClient> {
  const auth =
    params.auth ??
    (await resolveMatrixAuth({ cfg: params.cfg, env: params.env, accountId: params.accountId }));
  const key = buildSharedClientKey(auth, params.accountId);
  const shouldStart = params.startClient !== false;

  // Check if we already have a client for this key
  const existingState = sharedClientStates.get(key);
  if (existingState) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: existingState,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return existingState.client;
  }

  // Check if there's a pending creation for this key
  const existingPromise = sharedClientPromises.get(key);
  if (existingPromise) {
    const pending = await existingPromise;
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: pending,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return pending.client;
  }

  // Create a new client for this account
  const createPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  sharedClientPromises.set(key, createPromise);
  try {
    const created = await createPromise;
    sharedClientStates.set(key, created);
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: created,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return created.client;
  } finally {
    sharedClientPromises.delete(key);
  }
}

export async function waitForMatrixSync(_params: {
  client: MatrixClient;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  // @vector-im/matrix-bot-sdk handles sync internally in start()
  // This is kept for API compatibility but is essentially a no-op now
}

export function stopSharedClient(key?: string): void {
  if (key) {
    // Stop a specific client
    const state = sharedClientStates.get(key);
    if (state) {
      state.client.stop();
      sharedClientStates.delete(key);
    }
  } else {
    // Stop all clients (backward compatible behavior)
    for (const state of sharedClientStates.values()) {
      state.client.stop();
    }
    sharedClientStates.clear();
  }
}

/**
 * Stop the shared client for a specific account.
 * Use this instead of stopSharedClient() when shutting down a single account
 * to avoid stopping all accounts.
 */
export function stopSharedClientForAccount(auth: MatrixAuth, accountId?: string | null): void {
  const key = buildSharedClientKey(auth, accountId);
  stopSharedClient(key);
}
