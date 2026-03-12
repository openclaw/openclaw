import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { LogService } from "../sdk/logger.js";
import { resolveMatrixAuth, resolveMatrixAuthContext } from "./config.js";
import { createMatrixClient } from "./create-client.js";
import type { MatrixAuth } from "./types.js";

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
  startPromise: Promise<void> | null;
};

const sharedClientStates = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();

function buildSharedClientKey(auth: MatrixAuth): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    auth.accountId,
  ].join("|");
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
}): Promise<SharedMatrixClientState> {
  const client = await createMatrixClient({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    password: params.auth.password,
    deviceId: params.auth.deviceId,
    encryption: params.auth.encryption,
    localTimeoutMs: params.timeoutMs,
    initialSyncLimit: params.auth.initialSyncLimit,
    accountId: params.auth.accountId,
  });
  return {
    client,
    key: buildSharedClientKey(params.auth),
    started: false,
    cryptoReady: false,
    startPromise: null,
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
  if (params.state.startPromise) {
    await params.state.startPromise;
    return;
  }

  params.state.startPromise = (async () => {
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

  try {
    await params.state.startPromise;
  } finally {
    params.state.startPromise = null;
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
  const requestedAccountId = normalizeOptionalAccountId(params.accountId);
  if (params.auth && requestedAccountId && requestedAccountId !== params.auth.accountId) {
    throw new Error(
      `Matrix shared client account mismatch: requested ${requestedAccountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const authContext = params.auth
    ? null
    : resolveMatrixAuthContext({
        cfg: params.cfg,
        env: params.env,
        accountId: params.accountId,
      });
  const auth =
    params.auth ??
    (await resolveMatrixAuth({
      cfg: authContext?.cfg ?? params.cfg,
      env: authContext?.env ?? params.env,
      accountId: authContext?.accountId,
    }));
  const key = buildSharedClientKey(auth);
  const shouldStart = params.startClient !== false;

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

  const creationPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
  });
  sharedClientPromises.set(key, creationPromise);

  try {
    const created = await creationPromise;
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

export function stopSharedClient(): void {
  for (const state of sharedClientStates.values()) {
    state.client.stop();
  }
  sharedClientStates.clear();
  sharedClientPromises.clear();
}

export function stopSharedClientForAccount(auth: MatrixAuth): void {
  const key = buildSharedClientKey(auth);
  const state = sharedClientStates.get(key);
  if (!state) {
    return;
  }
  state.client.stop();
  sharedClientStates.delete(key);
  sharedClientPromises.delete(key);
}
