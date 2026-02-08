import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { LogService } from "@vector-im/matrix-bot-sdk";
import type { CoreConfig } from "../types.js";
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

/** Per-account shared client states. */
const sharedClients = new Map<string, SharedMatrixClientState>();
const pendingCreations = new Map<string, Promise<SharedMatrixClientState>>();
const pendingStarts = new Map<string, Promise<void>>();

function resolveAccountKey(accountId?: string | null): string {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}

function buildSharedClientKey(auth: MatrixAuth, accountId?: string | null): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    resolveAccountKey(accountId),
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
  accountKey: string;
}): Promise<void> {
  if (params.state.started) {
    return;
  }
  const existing = pendingStarts.get(params.accountKey);
  if (existing) {
    await existing;
    return;
  }
  const promise = (async () => {
    const client = params.state.client;

    // Initialize crypto if enabled
    if (params.encryption && !params.state.cryptoReady) {
      try {
        const joinedRooms = await client.getJoinedRooms();
        if (client.crypto) {
          await client.crypto.prepare(joinedRooms);
          params.state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await client.start();
    params.state.started = true;
  })();
  pendingStarts.set(params.accountKey, promise);
  try {
    await promise;
  } finally {
    pendingStarts.delete(params.accountKey);
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
  const accountKey = resolveAccountKey(params.accountId);
  const key = buildSharedClientKey(auth, params.accountId);
  const shouldStart = params.startClient !== false;

  const existing = sharedClients.get(accountKey);
  if (existing?.key === key) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: existing,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
        accountKey,
      });
    }
    return existing.client;
  }

  const pending = pendingCreations.get(accountKey);
  if (pending) {
    const pendingState = await pending;
    if (pendingState.key === key) {
      if (shouldStart) {
        await ensureSharedClientStarted({
          state: pendingState,
          timeoutMs: params.timeoutMs,
          initialSyncLimit: auth.initialSyncLimit,
          encryption: auth.encryption,
          accountKey,
        });
      }
      return pendingState.client;
    }
    pendingState.client.stop();
    sharedClients.delete(accountKey);
    pendingCreations.delete(accountKey);
  }

  // Stop any existing client for this account with a different key
  if (existing) {
    existing.client.stop();
    sharedClients.delete(accountKey);
  }

  const creationPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  pendingCreations.set(accountKey, creationPromise);
  try {
    const created = await creationPromise;
    sharedClients.set(accountKey, created);
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: created,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
        accountKey,
      });
    }
    return created.client;
  } finally {
    pendingCreations.delete(accountKey);
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

export function stopSharedClient(accountId?: string | null): void {
  if (accountId !== undefined) {
    const accountKey = resolveAccountKey(accountId);
    const state = sharedClients.get(accountKey);
    if (state) {
      state.client.stop();
      sharedClients.delete(accountKey);
    }
    return;
  }
  // Stop all shared clients (backward compat: no args = stop all)
  for (const [key, state] of sharedClients) {
    state.client.stop();
    sharedClients.delete(key);
  }
}
