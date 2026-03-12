import {
  DEFAULT_ACCOUNT_ID,
  isPrivateOrLoopbackHost,
  normalizeAccountId,
  normalizeOptionalAccountId,
  normalizeResolvedSecretInputString,
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "openclaw/plugin-sdk/matrix";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { findMatrixAccountConfig, resolveMatrixBaseConfig } from "../account-config.js";
import { resolveMatrixConfigFieldPath } from "../config-update.js";
import { MatrixClient } from "../sdk.js";
import { ensureMatrixSdkLoggingConfigured } from "./logging.js";
import type { MatrixAuth, MatrixResolvedConfig } from "./types.js";

function clean(value: unknown, path: string): string {
  return normalizeResolvedSecretInputString({ value, path }) ?? "";
}

type MatrixEnvConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
};

type MatrixConfigStringField =
  | "homeserver"
  | "userId"
  | "accessToken"
  | "password"
  | "deviceId"
  | "deviceName";

function resolveMatrixBaseConfigFieldPath(field: MatrixConfigStringField): string {
  return `channels.matrix.${field}`;
}

function readMatrixBaseConfigField(
  matrix: ReturnType<typeof resolveMatrixBaseConfig>,
  field: MatrixConfigStringField,
): string {
  return clean(matrix[field], resolveMatrixBaseConfigFieldPath(field));
}

function readMatrixAccountConfigField(
  cfg: CoreConfig,
  accountId: string,
  account: Partial<Record<MatrixConfigStringField, unknown>>,
  field: MatrixConfigStringField,
): string {
  return clean(account[field], resolveMatrixConfigFieldPath(cfg, accountId, field));
}

function resolveMatrixStringField(params: {
  matrix: ReturnType<typeof resolveMatrixBaseConfig>;
  field: MatrixConfigStringField;
  accountValue?: string;
  scopedEnvValue?: string;
  globalEnvValue?: string;
}): string {
  return (
    params.accountValue ||
    params.scopedEnvValue ||
    readMatrixBaseConfigField(params.matrix, params.field) ||
    params.globalEnvValue ||
    ""
  );
}

function clampMatrixInitialSyncLimit(value: unknown): number | undefined {
  return typeof value === "number" ? Math.max(0, Math.floor(value)) : undefined;
}

function resolveGlobalMatrixEnvConfig(env: NodeJS.ProcessEnv): MatrixEnvConfig {
  return {
    homeserver: clean(env.MATRIX_HOMESERVER, "MATRIX_HOMESERVER"),
    userId: clean(env.MATRIX_USER_ID, "MATRIX_USER_ID"),
    accessToken: clean(env.MATRIX_ACCESS_TOKEN, "MATRIX_ACCESS_TOKEN") || undefined,
    password: clean(env.MATRIX_PASSWORD, "MATRIX_PASSWORD") || undefined,
    deviceId: clean(env.MATRIX_DEVICE_ID, "MATRIX_DEVICE_ID") || undefined,
    deviceName: clean(env.MATRIX_DEVICE_NAME, "MATRIX_DEVICE_NAME") || undefined,
  };
}

function resolveMatrixEnvAccountToken(accountId: string): string {
  return normalizeAccountId(accountId)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function getMatrixScopedEnvVarNames(accountId: string): {
  homeserver: string;
  userId: string;
  accessToken: string;
  password: string;
  deviceId: string;
  deviceName: string;
} {
  const token = resolveMatrixEnvAccountToken(accountId);
  return {
    homeserver: `MATRIX_${token}_HOMESERVER`,
    userId: `MATRIX_${token}_USER_ID`,
    accessToken: `MATRIX_${token}_ACCESS_TOKEN`,
    password: `MATRIX_${token}_PASSWORD`, // pragma: allowlist secret
    deviceId: `MATRIX_${token}_DEVICE_ID`,
    deviceName: `MATRIX_${token}_DEVICE_NAME`,
  };
}

export function resolveScopedMatrixEnvConfig(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixEnvConfig {
  const keys = getMatrixScopedEnvVarNames(accountId);
  return {
    homeserver: clean(env[keys.homeserver], keys.homeserver),
    userId: clean(env[keys.userId], keys.userId),
    accessToken: clean(env[keys.accessToken], keys.accessToken) || undefined,
    password: clean(env[keys.password], keys.password) || undefined,
    deviceId: clean(env[keys.deviceId], keys.deviceId) || undefined,
    deviceName: clean(env[keys.deviceName], keys.deviceName) || undefined,
  };
}

export function hasReadyMatrixEnvAuth(config: {
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
}): boolean {
  const homeserver = clean(config.homeserver, "matrix.env.homeserver");
  const userId = clean(config.userId, "matrix.env.userId");
  const accessToken = clean(config.accessToken, "matrix.env.accessToken");
  const password = clean(config.password, "matrix.env.password");
  return Boolean(homeserver && (accessToken || (userId && password)));
}

export function validateMatrixHomeserverUrl(homeserver: string): string {
  const trimmed = clean(homeserver, "matrix.homeserver");
  if (!trimmed) {
    throw new Error("Matrix homeserver is required (matrix.homeserver)");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Matrix homeserver must be a valid http(s) URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Matrix homeserver must use http:// or https://");
  }
  if (!parsed.hostname) {
    throw new Error("Matrix homeserver must include a hostname");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Matrix homeserver URL must not include embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Matrix homeserver URL must not include query strings or fragments");
  }
  if (parsed.protocol === "http:" && !isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
  }

  return trimmed;
}

export function resolveMatrixConfig(
  cfg: CoreConfig = getMatrixRuntime().config.loadConfig() as CoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const matrix = resolveMatrixBaseConfig(cfg);
  const defaultScopedEnv = resolveScopedMatrixEnvConfig(DEFAULT_ACCOUNT_ID, env);
  const globalEnv = resolveGlobalMatrixEnvConfig(env);
  const homeserver = resolveMatrixStringField({
    matrix,
    field: "homeserver",
    scopedEnvValue: defaultScopedEnv.homeserver,
    globalEnvValue: globalEnv.homeserver,
  });
  const userId = resolveMatrixStringField({
    matrix,
    field: "userId",
    scopedEnvValue: defaultScopedEnv.userId,
    globalEnvValue: globalEnv.userId,
  });
  const accessToken =
    resolveMatrixStringField({
      matrix,
      field: "accessToken",
      scopedEnvValue: defaultScopedEnv.accessToken,
      globalEnvValue: globalEnv.accessToken,
    }) || undefined;
  const password =
    resolveMatrixStringField({
      matrix,
      field: "password",
      scopedEnvValue: defaultScopedEnv.password,
      globalEnvValue: globalEnv.password,
    }) || undefined;
  const deviceId =
    resolveMatrixStringField({
      matrix,
      field: "deviceId",
      scopedEnvValue: defaultScopedEnv.deviceId,
      globalEnvValue: globalEnv.deviceId,
    }) || undefined;
  const deviceName =
    resolveMatrixStringField({
      matrix,
      field: "deviceName",
      scopedEnvValue: defaultScopedEnv.deviceName,
      globalEnvValue: globalEnv.deviceName,
    }) || undefined;
  const initialSyncLimit = clampMatrixInitialSyncLimit(matrix.initialSyncLimit);
  const encryption = matrix.encryption ?? false;
  return {
    homeserver,
    userId,
    accessToken,
    password,
    deviceId,
    deviceName,
    initialSyncLimit,
    encryption,
  };
}

export function resolveMatrixConfigForAccount(
  cfg: CoreConfig,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const matrix = resolveMatrixBaseConfig(cfg);
  const account = findMatrixAccountConfig(cfg, accountId) ?? {};
  const normalizedAccountId = normalizeAccountId(accountId);
  const scopedEnv = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
  const globalEnv = resolveGlobalMatrixEnvConfig(env);
  const accountField = (field: MatrixConfigStringField) =>
    readMatrixAccountConfigField(cfg, normalizedAccountId, account, field);
  const homeserver = resolveMatrixStringField({
    matrix,
    field: "homeserver",
    accountValue: accountField("homeserver"),
    scopedEnvValue: scopedEnv.homeserver,
    globalEnvValue: globalEnv.homeserver,
  });
  const userId = resolveMatrixStringField({
    matrix,
    field: "userId",
    accountValue: accountField("userId"),
    scopedEnvValue: scopedEnv.userId,
    globalEnvValue: globalEnv.userId,
  });
  const accessToken =
    resolveMatrixStringField({
      matrix,
      field: "accessToken",
      accountValue: accountField("accessToken"),
      scopedEnvValue: scopedEnv.accessToken,
      globalEnvValue: globalEnv.accessToken,
    }) || undefined;
  const password =
    resolveMatrixStringField({
      matrix,
      field: "password",
      accountValue: accountField("password"),
      scopedEnvValue: scopedEnv.password,
      globalEnvValue: globalEnv.password,
    }) || undefined;
  const deviceId =
    resolveMatrixStringField({
      matrix,
      field: "deviceId",
      accountValue: accountField("deviceId"),
      scopedEnvValue: scopedEnv.deviceId,
      globalEnvValue: globalEnv.deviceId,
    }) || undefined;
  const deviceName =
    resolveMatrixStringField({
      matrix,
      field: "deviceName",
      accountValue: accountField("deviceName"),
      scopedEnvValue: scopedEnv.deviceName,
      globalEnvValue: globalEnv.deviceName,
    }) || undefined;

  const accountInitialSyncLimit = clampMatrixInitialSyncLimit(account.initialSyncLimit);
  const initialSyncLimit =
    accountInitialSyncLimit ?? clampMatrixInitialSyncLimit(matrix.initialSyncLimit);
  const encryption =
    typeof account.encryption === "boolean" ? account.encryption : (matrix.encryption ?? false);

  return {
    homeserver,
    userId,
    accessToken,
    password,
    deviceId,
    deviceName,
    initialSyncLimit,
    encryption,
  };
}

export function resolveImplicitMatrixAccountId(
  cfg: CoreConfig,
  _env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (requiresExplicitMatrixDefaultAccount(cfg)) {
    return null;
  }
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
}

export function resolveMatrixAuthContext(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
  resolved: MatrixResolvedConfig;
} {
  const cfg = params?.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
  const env = params?.env ?? process.env;
  const explicitAccountId = normalizeOptionalAccountId(params?.accountId);
  const effectiveAccountId = explicitAccountId ?? resolveImplicitMatrixAccountId(cfg, env);
  if (!effectiveAccountId) {
    throw new Error(
      'Multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set. Set "channels.matrix.defaultAccount" to the intended account or pass --account <id>.',
    );
  }
  const resolved = resolveMatrixConfigForAccount(cfg, effectiveAccountId, env);

  return {
    cfg,
    env,
    accountId: effectiveAccountId,
    resolved,
  };
}

export async function resolveMatrixAuth(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): Promise<MatrixAuth> {
  const { cfg, env, accountId, resolved } = resolveMatrixAuthContext(params);
  const homeserver = validateMatrixHomeserverUrl(resolved.homeserver);

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
      homeserver,
      userId: resolved.userId || "",
      accessToken: resolved.accessToken,
    })
      ? cached
      : null;

  // If we have an access token, we can fetch userId via whoami if not provided
  if (resolved.accessToken) {
    let userId = resolved.userId;
    const hasMatchingCachedToken = cachedCredentials?.accessToken === resolved.accessToken;
    let knownDeviceId = hasMatchingCachedToken
      ? cachedCredentials?.deviceId || resolved.deviceId
      : resolved.deviceId;

    if (!userId || !knownDeviceId) {
      // Fetch whoami when we need to resolve userId and/or deviceId from token auth.
      ensureMatrixSdkLoggingConfigured();
      const tempClient = new MatrixClient(homeserver, resolved.accessToken);
      const whoami = (await tempClient.doRequest("GET", "/_matrix/client/v3/account/whoami")) as {
        user_id?: string;
        device_id?: string;
      };
      if (!userId) {
        const fetchedUserId = whoami.user_id?.trim();
        if (!fetchedUserId) {
          throw new Error("Matrix whoami did not return user_id");
        }
        userId = fetchedUserId;
      }
      if (!knownDeviceId) {
        knownDeviceId = whoami.device_id?.trim() || resolved.deviceId;
      }
    }

    const shouldRefreshCachedCredentials =
      !cachedCredentials ||
      !hasMatchingCachedToken ||
      cachedCredentials.userId !== userId ||
      (cachedCredentials.deviceId || undefined) !== knownDeviceId;
    if (shouldRefreshCachedCredentials) {
      await saveMatrixCredentials(
        {
          homeserver,
          userId,
          accessToken: resolved.accessToken,
          deviceId: knownDeviceId,
        },
        env,
        accountId,
      );
    } else if (hasMatchingCachedToken) {
      await touchMatrixCredentials(env, accountId);
    }
    return {
      accountId,
      homeserver,
      userId,
      accessToken: resolved.accessToken,
      password: resolved.password,
      deviceId: knownDeviceId,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  if (cachedCredentials) {
    await touchMatrixCredentials(env, accountId);
    return {
      accountId,
      homeserver: cachedCredentials.homeserver,
      userId: cachedCredentials.userId,
      accessToken: cachedCredentials.accessToken,
      password: resolved.password,
      deviceId: cachedCredentials.deviceId || resolved.deviceId,
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

  // Login with password using the same hardened request path as other Matrix HTTP calls.
  ensureMatrixSdkLoggingConfigured();
  const loginClient = new MatrixClient(homeserver, "");
  const login = (await loginClient.doRequest("POST", "/_matrix/client/v3/login", undefined, {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: resolved.userId },
    password: resolved.password,
    device_id: resolved.deviceId,
    initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway",
  })) as {
    access_token?: string;
    user_id?: string;
    device_id?: string;
  };

  const accessToken = login.access_token?.trim();
  if (!accessToken) {
    throw new Error("Matrix login did not return an access token");
  }

  const auth: MatrixAuth = {
    accountId,
    homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken,
    password: resolved.password,
    deviceId: login.device_id ?? resolved.deviceId,
    deviceName: resolved.deviceName,
    initialSyncLimit: resolved.initialSyncLimit,
    encryption: resolved.encryption,
  };

  await saveMatrixCredentials(
    {
      homeserver: auth.homeserver,
      userId: auth.userId,
      accessToken: auth.accessToken,
      deviceId: auth.deviceId,
    },
    env,
    accountId,
  );

  return auth;
}
