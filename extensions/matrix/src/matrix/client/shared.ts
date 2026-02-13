import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { LogService } from "@vector-im/matrix-bot-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "./types.js";
import { resolveMatrixAuth } from "./config.js";
import { createMatrixClient } from "./create-client.js";

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
};

// ---------------------------------------------------------------------------
// Per-account shared client registry (replaces the former singleton)
// ---------------------------------------------------------------------------

const sharedClients = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();
const sharedClientStartPromises = new Map<string, Promise<void>>();

function buildSharedClientKey(auth: MatrixAuth, accountId?: string | null): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    normalizeAccountId(accountId),
  ].join("|");
}

async function createSharedMatrixClientState(params: {
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
  accountKey: string;
  timeoutMs?: number;
  initialSyncLimit?: number;
  encryption?: boolean;
}): Promise<void> {
  if (params.state.started) {
    return;
  }
  const existing = sharedClientStartPromises.get(params.accountKey);
  if (existing) {
    await existing;
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
  sharedClientStartPromises.set(params.accountKey, startPromise);
  try {
    await startPromise;
  } finally {
    sharedClientStartPromises.delete(params.accountKey);
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
  const auth = params.auth ?? (await resolveMatrixAuth({ cfg: params.cfg, env: params.env }));
  const accountKey = normalizeAccountId(params.accountId);
  const key = buildSharedClientKey(auth, params.accountId);
  const shouldStart = params.startClient !== false;

  // Check if we already have a matching client for this account
  const existing = sharedClients.get(accountKey);
  if (existing?.key === key) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: existing,
        accountKey,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return existing.client;
  }

  // If there's an in-flight creation for this account, wait for it
  const pendingPromise = sharedClientPromises.get(accountKey);
  if (pendingPromise) {
    const pending = await pendingPromise;
    if (pending.key === key) {
      if (shouldStart) {
        await ensureSharedClientStarted({
          state: pending,
          accountKey,
          timeoutMs: params.timeoutMs,
          initialSyncLimit: auth.initialSyncLimit,
          encryption: auth.encryption,
        });
      }
      return pending.client;
    }
    // Key mismatch — stop the old client and create a new one
    pending.client.stop();
    sharedClients.delete(accountKey);
    sharedClientPromises.delete(accountKey);
  }

  // Stop the existing client for this account if key changed
  if (existing) {
    existing.client.stop();
    sharedClients.delete(accountKey);
  }

  const createPromise = createSharedMatrixClientState({
    auth,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  sharedClientPromises.set(accountKey, createPromise);
  try {
    const created = await createPromise;
    sharedClients.set(accountKey, created);
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: created,
        accountKey,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return created.client;
  } finally {
    sharedClientPromises.delete(accountKey);
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

/** Stop the shared client for a specific account (or the default). */
export function stopSharedClient(accountId?: string | null): void {
  const key = normalizeAccountId(accountId);
  const state = sharedClients.get(key);
  if (state) {
    state.client.stop();
    sharedClients.delete(key);
  }
}

/** Stop all shared clients (used during full shutdown). */
export function stopAllSharedClients(): void {
  for (const state of sharedClients.values()) {
    state.client.stop();
  }
  sharedClients.clear();
}
