import { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { CoreConfig } from "../types.js";
import type { MatrixAuth, MatrixResolvedConfig } from "./types.js";
import { getMatrixRuntime } from "../../runtime.js";
import { ensureMatrixSdkLoggingConfigured } from "./logging.js";

function clean(value?: string): string {
  return value?.trim() ?? "";
}

/**
 * Resolve the Matrix connection config for a given account.
 *
 * For the default account (or when no accountId is given), reads from the
 * top-level `channels.matrix` fields and falls back to env vars.
 *
 * For named accounts, merges top-level base fields with per-account overrides
 * from `channels.matrix.accounts.<accountId>`. Named accounts do NOT fall
 * back to env vars for credentials — only the default account does.
 */
export function resolveMatrixConfig(
  cfg: CoreConfig = getMatrixRuntime().config.loadConfig() as CoreConfig,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixResolvedConfig {
  const matrix = cfg.channels?.matrix ?? {};
  const isNamedAccount = accountId && accountId !== "default" && matrix.accounts?.[accountId];

  if (isNamedAccount) {
    const accountCfg = matrix.accounts![accountId]!;
    // Named account: merge base fields with account overrides, no env fallback for credentials
    const homeserver = clean(accountCfg.homeserver) || clean(matrix.homeserver);
    const userId = clean(accountCfg.userId) || clean(matrix.userId);
    const accessToken = clean(accountCfg.accessToken) || undefined;
    const password = clean(accountCfg.password) || undefined;
    const deviceName = clean(accountCfg.deviceName) || clean(matrix.deviceName) || undefined;
    const rawSyncLimit = accountCfg.initialSyncLimit ?? matrix.initialSyncLimit;
    const initialSyncLimit =
      typeof rawSyncLimit === "number" ? Math.max(0, Math.floor(rawSyncLimit)) : undefined;
    const encryption = accountCfg.encryption ?? matrix.encryption ?? false;
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

  // Default account: original behavior with env fallbacks
  const homeserver = clean(matrix.homeserver) || clean(env.MATRIX_HOMESERVER);
  const userId = clean(matrix.userId) || clean(env.MATRIX_USER_ID);
  const accessToken = clean(matrix.accessToken) || clean(env.MATRIX_ACCESS_TOKEN) || undefined;
  const password = clean(matrix.password) || clean(env.MATRIX_PASSWORD) || undefined;
  const deviceName = clean(matrix.deviceName) || clean(env.MATRIX_DEVICE_NAME) || undefined;
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
  accountId?: string | null;
}): Promise<MatrixAuth> {
  const cfg = params?.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
  const env = params?.env ?? process.env;
  const accountId = params?.accountId;
  const resolved = resolveMatrixConfig(cfg, env, accountId);
  if (!resolved.homeserver) {
    const label = accountId && accountId !== "default" ? ` (account: ${accountId})` : "";
    throw new Error(`Matrix homeserver is required${label} (matrix.homeserver)`);
  }

  const {
    loadMatrixCredentials,
    saveMatrixCredentials,
    credentialsMatchConfig,
    touchMatrixCredentials,
  } = await import("../credentials.js");

  const cached = loadMatrixCredentials(env, accountId);
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
      saveMatrixCredentials(
        {
          homeserver: resolved.homeserver,
          userId,
          accessToken: resolved.accessToken,
        },
        env,
        accountId,
      );
    } else if (cachedCredentials && cachedCredentials.accessToken === resolved.accessToken) {
      touchMatrixCredentials(env, accountId);
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
    touchMatrixCredentials(env, accountId);
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
    throw new Error("Matrix userId is required when no access token is configured (matrix.userId)");
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
      initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway",
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

  saveMatrixCredentials(
    {
      homeserver: auth.homeserver,
      userId: auth.userId,
      accessToken: auth.accessToken,
      deviceId: login.device_id,
    },
    env,
    accountId,
  );

  return auth;
}
