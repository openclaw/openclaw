import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";

type MatrixEnvConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveGlobalMatrixEnvConfig(env: NodeJS.ProcessEnv): MatrixEnvConfig {
  return {
    homeserver: clean(env.MATRIX_HOMESERVER),
    userId: clean(env.MATRIX_USER_ID),
    accessToken: clean(env.MATRIX_ACCESS_TOKEN) || undefined,
    password: clean(env.MATRIX_PASSWORD) || undefined,
    deviceId: clean(env.MATRIX_DEVICE_ID) || undefined,
    deviceName: clean(env.MATRIX_DEVICE_NAME) || undefined,
  };
}

export function resolveScopedMatrixEnvConfig(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixEnvConfig {
  const keys = getMatrixScopedEnvVarNames(accountId);
  return {
    homeserver: clean(env[keys.homeserver]),
    userId: clean(env[keys.userId]),
    accessToken: clean(env[keys.accessToken]) || undefined,
    password: clean(env[keys.password]) || undefined,
    deviceId: clean(env[keys.deviceId]) || undefined,
    deviceName: clean(env[keys.deviceName]) || undefined,
  };
}

export function hasReadyMatrixEnvAuth(config: {
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
}): boolean {
  const homeserver = clean(config.homeserver);
  const userId = clean(config.userId);
  const accessToken = clean(config.accessToken);
  const password = clean(config.password);
  return Boolean(homeserver && (accessToken || (userId && password)));
}

export function resolveMatrixEnvAuthReadiness(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  ready: boolean;
  homeserver?: string;
  userId?: string;
  sourceHint: string;
  missingMessage: string;
} {
  const normalizedAccountId = normalizeAccountId(accountId);
  const scoped = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
  if (normalizedAccountId !== DEFAULT_ACCOUNT_ID) {
    const keys = getMatrixScopedEnvVarNames(normalizedAccountId);
    return {
      ready: hasReadyMatrixEnvAuth(scoped),
      homeserver: scoped.homeserver || undefined,
      userId: scoped.userId || undefined,
      sourceHint: `${keys.homeserver} (+ auth vars)`,
      missingMessage: `Set per-account env vars for "${normalizedAccountId}" (for example ${keys.homeserver} + ${keys.accessToken} or ${keys.userId} + ${keys.password}).`,
    };
  }

  const defaultScoped = resolveScopedMatrixEnvConfig(DEFAULT_ACCOUNT_ID, env);
  const global = resolveGlobalMatrixEnvConfig(env);
  const defaultKeys = getMatrixScopedEnvVarNames(DEFAULT_ACCOUNT_ID);
  return {
    ready: hasReadyMatrixEnvAuth(defaultScoped) || hasReadyMatrixEnvAuth(global),
    homeserver: defaultScoped.homeserver || global.homeserver || undefined,
    userId: defaultScoped.userId || global.userId || undefined,
    sourceHint: "MATRIX_* or MATRIX_DEFAULT_*",
    missingMessage:
      `Set Matrix env vars for the default account ` +
      `(for example MATRIX_HOMESERVER + MATRIX_ACCESS_TOKEN, MATRIX_USER_ID + MATRIX_PASSWORD, ` +
      `or ${defaultKeys.homeserver} + ${defaultKeys.accessToken}).`,
  };
}
