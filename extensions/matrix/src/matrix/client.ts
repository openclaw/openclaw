import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ConsoleLogger,
  LogService,
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
} from "matrix-bot-sdk";
import type { IStorageProvider, ICryptoStorageProvider } from "matrix-bot-sdk";

import type { CoreConfig } from "../types.js";
import { getMatrixRuntime } from "../runtime.js";

export type MatrixResolvedConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
};

/**
 * Authenticated Matrix configuration.
 * Note: deviceId is NOT included here because it's implicit in the accessToken.
 * The crypto storage assumes the device ID (and thus access token) does not change
 * between restarts. If the access token becomes invalid or crypto storage is lost,
 * both will need to be recreated together.
 */
export type MatrixAuth = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
};

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  started: boolean;
  cryptoReady: boolean;
};

let sharedClientState: SharedMatrixClientState | null = null;
let sharedClientPromise: Promise<SharedMatrixClientState> | null = null;
let sharedClientStartPromise: Promise<void> | null = null;

export function isBunRuntime(): boolean {
  const versions = process.versions as { bun?: string };
  return typeof versions.bun === "string";
}

let matrixSdkLoggingConfigured = false;
const matrixSdkBaseLogger = new ConsoleLogger();

function shouldSuppressMatrixHttpNotFound(
  module: string,
  messageOrObject: unknown[],
): boolean {
  if (module !== "MatrixHttpClient") return false;
  return messageOrObject.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { errcode?: string }).errcode === "M_NOT_FOUND";
  });
}

function ensureMatrixSdkLoggingConfigured(): void {
  if (matrixSdkLoggingConfigured) return;
  matrixSdkLoggingConfigured = true;

  LogService.setLogger({
    trace: (module, ...messageOrObject) =>
      matrixSdkBaseLogger.trace(module, ...messageOrObject),
    debug: (module, ...messageOrObject) =>
      matrixSdkBaseLogger.debug(module, ...messageOrObject),
    info: (module, ...messageOrObject) =>
      matrixSdkBaseLogger.info(module, ...messageOrObject),
    warn: (module, ...messageOrObject) =>
      matrixSdkBaseLogger.warn(module, ...messageOrObject),
    error: (module, ...messageOrObject) => {
      if (shouldSuppressMatrixHttpNotFound(module, messageOrObject)) return;
      matrixSdkBaseLogger.error(module, ...messageOrObject);
    },
  });
}

function clean(value?: string): string {
  return value?.trim() ?? "";
}

const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";

type MatrixStoragePaths = {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
  metaPath: string;
  accountKey: string;
  tokenHash: string;
};

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function resolveHomeserverKey(homeserver: string): string {
  try {
    const url = new URL(homeserver);
    if (url.host) return sanitizePathSegment(url.host);
  } catch {
    // fall through
  }
  return sanitizePathSegment(homeserver);
}

function hashAccessToken(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function resolveLegacyStoragePaths(env: NodeJS.ProcessEnv = process.env): {
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return {
    storagePath: path.join(stateDir, "matrix", "bot-storage.json"),
    cryptoPath: path.join(stateDir, "matrix", "crypto"),
  };
}

function resolveMatrixStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): MatrixStoragePaths {
  const env = params.env ?? process.env;
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const accountKey = sanitizePathSegment(params.accountId ?? DEFAULT_ACCOUNT_KEY);
  const userKey = sanitizePathSegment(params.userId);
  const serverKey = resolveHomeserverKey(params.homeserver);
  const tokenHash = hashAccessToken(params.accessToken);
  const rootDir = path.join(
    stateDir,
    "matrix",
    "accounts",
    accountKey,
    `${serverKey}__${userKey}`,
    tokenHash,
  );
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    metaPath: path.join(rootDir, STORAGE_META_FILENAME),
    accountKey,
    tokenHash,
  };
}

function maybeMigrateLegacyStorage(params: {
  storagePaths: MatrixStoragePaths;
  env?: NodeJS.ProcessEnv;
}): void {
  const legacy = resolveLegacyStoragePaths(params.env);
  const hasLegacyStorage = fs.existsSync(legacy.storagePath);
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  const hasNewStorage =
    fs.existsSync(params.storagePaths.storagePath) ||
    fs.existsSync(params.storagePaths.cryptoPath);

  if (!hasLegacyStorage && !hasLegacyCrypto) return;
  if (hasNewStorage) return;

  fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
  if (hasLegacyStorage) {
    try {
      fs.renameSync(legacy.storagePath, params.storagePaths.storagePath);
    } catch {
      // Ignore migration failures; new store will be created.
    }
  }
  if (hasLegacyCrypto) {
    try {
      fs.renameSync(legacy.cryptoPath, params.storagePaths.cryptoPath);
    } catch {
      // Ignore migration failures; new store will be created.
    }
  }
}

function writeStorageMeta(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
}): void {
  try {
    const payload = {
      homeserver: params.homeserver,
      userId: params.userId,
      accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
      accessTokenHash: params.storagePaths.tokenHash,
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(
      params.storagePaths.metaPath,
      JSON.stringify(payload, null, 2),
      "utf-8",
    );
  } catch {
    // ignore meta write failures
  }
}

function sanitizeUserIdList(input: unknown, label: string): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    LogService.warn(
      "MatrixClientLite",
      `Expected ${label} list to be an array, got ${typeof input}`,
    );
    return [];
  }
  const filtered = input.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  if (filtered.length !== input.length) {
    LogService.warn(
      "MatrixClientLite",
      `Dropping ${input.length - filtered.length} invalid ${label} entries from sync payload`,
    );
  }
  return filtered;
}

export function resolveMatrixConfig(
  cfg: CoreConfig = getMatrixRuntime().config.loadConfig() as CoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const matrix = cfg.channels?.matrix ?? {};
  const homeserver = clean(matrix.homeserver) || clean(env.MATRIX_HOMESERVER);
  const userId = clean(matrix.userId) || clean(env.MATRIX_USER_ID);
  const accessToken =
    clean(matrix.accessToken) || clean(env.MATRIX_ACCESS_TOKEN) || undefined;
  const password = clean(matrix.password) || clean(env.MATRIX_PASSWORD) || undefined;
  const deviceName =
    clean(matrix.deviceName) || clean(env.MATRIX_DEVICE_NAME) || undefined;
  const initialSyncLimit =
    typeof matrix.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(matrix.initialSyncLimit))
      : undefined;
  const encryption = matrix.encryption ?? false;
  return {
    homeserver,
    userId,
    accessToken,
    password,
    deviceName,
    initialSyncLimit,
    encryption,
  };
}

export async function resolveMatrixAuth(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MatrixAuth> {
  const cfg = params?.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
  const env = params?.env ?? process.env;
  const resolved = resolveMatrixConfig(cfg, env);
  if (!resolved.homeserver) {
    throw new Error("Matrix homeserver is required (matrix.homeserver)");
  }

  const {
    loadMatrixCredentials,
    saveMatrixCredentials,
    credentialsMatchConfig,
    touchMatrixCredentials,
  } = await import("./credentials.js");

  const cached = loadMatrixCredentials(env);
  const cachedCredentials =
    cached &&
    credentialsMatchConfig(cached, {
      homeserver: resolved.homeserver,
      userId: resolved.userId || "",
    })
      ? cached
      : null;

  // If we have an access token, we can fetch userId via whoami if not provided
  if (resolved.accessToken) {
    let userId = resolved.userId;
    if (!userId) {
      // Fetch userId from access token via whoami
      ensureMatrixSdkLoggingConfigured();
      const tempClient = new MatrixClient(resolved.homeserver, resolved.accessToken);
      const whoami = await tempClient.getUserId();
      userId = whoami;
      // Save the credentials with the fetched userId
      saveMatrixCredentials({
        homeserver: resolved.homeserver,
        userId,
        accessToken: resolved.accessToken,
      });
    } else if (cachedCredentials && cachedCredentials.accessToken === resolved.accessToken) {
      touchMatrixCredentials(env);
    }
    return {
      homeserver: resolved.homeserver,
      userId,
      accessToken: resolved.accessToken,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  if (cachedCredentials) {
    touchMatrixCredentials(env);
    return {
      homeserver: cachedCredentials.homeserver,
      userId: cachedCredentials.userId,
      accessToken: cachedCredentials.accessToken,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  if (!resolved.userId) {
    throw new Error(
      "Matrix userId is required when no access token is configured (matrix.userId)",
    );
  }

  if (!resolved.password) {
    throw new Error(
      "Matrix password is required when no access token is configured (matrix.password)",
    );
  }

  // Login with password using HTTP API
  const loginResponse = await fetch(`${resolved.homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: resolved.userId },
      password: resolved.password,
      initial_device_display_name: resolved.deviceName ?? "Clawdbot Gateway",
    }),
  });

  if (!loginResponse.ok) {
    const errorText = await loginResponse.text();
    throw new Error(`Matrix login failed: ${errorText}`);
  }

  const login = (await loginResponse.json()) as {
    access_token?: string;
    user_id?: string;
    device_id?: string;
  };
  
  const accessToken = login.access_token?.trim();
  if (!accessToken) {
    throw new Error("Matrix login did not return an access token");
  }

  const auth: MatrixAuth = {
    homeserver: resolved.homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken,
    deviceName: resolved.deviceName,
    initialSyncLimit: resolved.initialSyncLimit,
    encryption: resolved.encryption,
  };

  saveMatrixCredentials({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    deviceId: login.device_id,
  });

  return auth;
}

export async function createMatrixClient(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  encryption?: boolean;
  localTimeoutMs?: number;
  accountId?: string | null;
}): Promise<MatrixClient> {
  ensureMatrixSdkLoggingConfigured();
  const env = process.env;

  // Create storage provider
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
    env,
  });
  maybeMigrateLegacyStorage({ storagePaths, env });
  fs.mkdirSync(storagePaths.rootDir, { recursive: true });
  const storage: IStorageProvider = new SimpleFsStorageProvider(storagePaths.storagePath);

  // Create crypto storage if encryption is enabled
  let cryptoStorage: ICryptoStorageProvider | undefined;
  if (params.encryption) {
    fs.mkdirSync(storagePaths.cryptoPath, { recursive: true });

    try {
      const { StoreType } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
      cryptoStorage = new RustSdkCryptoStorageProvider(
        storagePaths.cryptoPath,
        StoreType.Sqlite,
      );
    } catch (err) {
      LogService.warn("MatrixClientLite", "Failed to initialize crypto storage, E2EE disabled:", err);
    }
  }

  writeStorageMeta({
    storagePaths,
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId,
  });

  const client = new MatrixClient(
    params.homeserver,
    params.accessToken,
    storage,
    cryptoStorage,
  );

  if (client.crypto) {
    const originalUpdateSyncData = client.crypto.updateSyncData.bind(client.crypto);
    client.crypto.updateSyncData = async (
      toDeviceMessages,
      otkCounts,
      unusedFallbackKeyAlgs,
      changedDeviceLists,
      leftDeviceLists,
    ) => {
      const safeChanged = sanitizeUserIdList(changedDeviceLists, "changed device list");
      const safeLeft = sanitizeUserIdList(leftDeviceLists, "left device list");
      try {
        return await originalUpdateSyncData(
          toDeviceMessages,
          otkCounts,
          unusedFallbackKeyAlgs,
          safeChanged,
          safeLeft,
        );
      } catch (err) {
        const message = typeof err === "string" ? err : err instanceof Error ? err.message : "";
        if (message.includes("Expect value to be String")) {
          LogService.warn(
            "MatrixClientLite",
            "Ignoring malformed device list entries during crypto sync",
            message,
          );
          return;
        }
        throw err;
      }
    };
  }

  return client;
}

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
  if (params.state.started) return;
  if (sharedClientStartPromise) {
    await sharedClientStartPromise;
    return;
  }
  sharedClientStartPromise = (async () => {
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
    await sharedClientStartPromise;
  } finally {
    sharedClientStartPromise = null;
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
  const key = buildSharedClientKey(auth, params.accountId);
  const shouldStart = params.startClient !== false;

  if (sharedClientState?.key === key) {
    if (shouldStart) {
      await ensureSharedClientStarted({
        state: sharedClientState,
        timeoutMs: params.timeoutMs,
        initialSyncLimit: auth.initialSyncLimit,
        encryption: auth.encryption,
      });
    }
    return sharedClientState.client;
  }

  if (sharedClientPromise) {
    const pending = await sharedClientPromise;
    if (pending.key === key) {
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
    pending.client.stop();
    sharedClientState = null;
    sharedClientPromise = null;
  }

  sharedClientPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  try {
    const created = await sharedClientPromise;
    sharedClientState = created;
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
    sharedClientPromise = null;
  }
}

export async function waitForMatrixSync(_params: {
  client: MatrixClient;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  // matrix-bot-sdk handles sync internally in start()
  // This is kept for API compatibility but is essentially a no-op now
}

export function stopSharedClient(): void {
  if (sharedClientState) {
    sharedClientState.client.stop();
    sharedClientState = null;
  }
}
