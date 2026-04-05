import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import { coerceSecretRef } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  isPrivateNetworkOptInEnabled,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMatrixAccountStringValues } from "../auth-precedence.js";
import { getMatrixScopedEnvVarNames } from "../env-vars.js";
import type { CoreConfig } from "../types.js";
import { findMatrixAccountConfig, resolveMatrixBaseConfig } from "./account-config.js";
import type { MatrixResolvedConfig } from "./client/types.js";
import { resolveMatrixConfigFieldPath } from "./config-paths.js";

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

function readEnvSecretRefFallback(params: {
  value: unknown;
  env?: NodeJS.ProcessEnv;
  config?: Pick<CoreConfig, "secrets">;
}): string | undefined {
  const ref = coerceSecretRef(params.value, params.config?.secrets?.defaults);
  if (!ref || ref.source !== "env" || !params.env) {
    return undefined;
  }

  const providerConfig = params.config?.secrets?.providers?.[ref.provider];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      throw new Error(
        `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
      );
    }
    if (providerConfig.allowlist && !providerConfig.allowlist.includes(ref.id)) {
      throw new Error(
        `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${ref.provider}.allowlist.`,
      );
    }
  } else if (ref.provider !== (params.config?.secrets?.defaults?.env?.trim() || "default")) {
    throw new Error(
      `Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`,
    );
  }

  const resolved = params.env[ref.id];
  if (typeof resolved !== "string") {
    return undefined;
  }

  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clean(
  value: unknown,
  path: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    config?: Pick<CoreConfig, "secrets">;
    allowEnvSecretRefFallback?: boolean;
    suppressSecretRef?: boolean;
  },
): string {
  const ref = coerceSecretRef(value, opts?.config?.secrets?.defaults);
  if (opts?.suppressSecretRef && ref) {
    return "";
  }
  const normalizedValue = opts?.allowEnvSecretRefFallback
    ? ref?.source === "env"
      ? (readEnvSecretRefFallback({
          value,
          env: opts.env,
          config: opts.config,
        }) ?? value)
      : ref
        ? ""
        : value
    : value;
  return (
    normalizeResolvedSecretInputString({
      value: normalizedValue,
      path,
      defaults: opts?.config?.secrets?.defaults,
    }) ?? ""
  );
}

function resolveMatrixBaseConfigFieldPath(field: MatrixConfigStringField): string {
  return `channels.matrix.${field}`;
}

function shouldAllowEnvSecretRefFallback(field: MatrixConfigStringField): boolean {
  return field === "accessToken" || field === "password";
}

function hasConfiguredSecretInputValue(value: unknown, cfg: Pick<CoreConfig, "secrets">): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    Boolean(coerceSecretRef(value, cfg.secrets?.defaults))
  );
}

function hasConfiguredMatrixAccessTokenSource(params: {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): boolean {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
  const scopedAccessTokenVar = getMatrixScopedEnvVarNames(normalizedAccountId).accessToken;
  if (
    hasConfiguredSecretInputValue(account.accessToken, params.cfg) ||
    clean(params.env[scopedAccessTokenVar], scopedAccessTokenVar).length > 0
  ) {
    return true;
  }
  if (normalizedAccountId !== DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const matrix = resolveMatrixBaseConfig(params.cfg);
  return (
    hasConfiguredSecretInputValue(matrix.accessToken, params.cfg) ||
    clean(params.env.MATRIX_ACCESS_TOKEN, "MATRIX_ACCESS_TOKEN").length > 0
  );
}

function readMatrixBaseConfigField(
  matrix: ReturnType<typeof resolveMatrixBaseConfig>,
  field: MatrixConfigStringField,
  opts?: {
    env?: NodeJS.ProcessEnv;
    config?: Pick<CoreConfig, "secrets">;
    suppressSecretRef?: boolean;
  },
): string {
  return clean(matrix[field], resolveMatrixBaseConfigFieldPath(field), {
    env: opts?.env,
    config: opts?.config,
    allowEnvSecretRefFallback: shouldAllowEnvSecretRefFallback(field),
    suppressSecretRef: opts?.suppressSecretRef,
  });
}

function readMatrixAccountConfigField(
  cfg: CoreConfig,
  accountId: string,
  account: Partial<Record<MatrixConfigStringField, unknown>>,
  field: MatrixConfigStringField,
  opts?: {
    env?: NodeJS.ProcessEnv;
    config?: Pick<CoreConfig, "secrets">;
    suppressSecretRef?: boolean;
  },
): string {
  return clean(account[field], resolveMatrixConfigFieldPath(cfg, accountId, field), {
    env: opts?.env,
    config: opts?.config,
    allowEnvSecretRefFallback: shouldAllowEnvSecretRefFallback(field),
    suppressSecretRef: opts?.suppressSecretRef,
  });
}

function clampMatrixInitialSyncLimit(value: unknown): number | undefined {
  return typeof value === "number" ? Math.max(0, Math.floor(value)) : undefined;
}

function buildMatrixNetworkFields(params: {
  allowPrivateNetwork: boolean | undefined;
  proxy?: string;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Pick<MatrixResolvedConfig, "allowPrivateNetwork" | "ssrfPolicy" | "dispatcherPolicy"> {
  const dispatcherPolicy: PinnedDispatcherPolicy | undefined =
    params.dispatcherPolicy ??
    (params.proxy ? { mode: "explicit-proxy", proxyUrl: params.proxy } : undefined);
  if (!params.allowPrivateNetwork && !dispatcherPolicy) {
    return {};
  }
  return {
    ...(params.allowPrivateNetwork
      ? {
          allowPrivateNetwork: true,
          ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
        }
      : {}),
    ...(dispatcherPolicy ? { dispatcherPolicy } : {}),
  };
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

function resolveScopedMatrixEnvConfig(accountId: string, env: NodeJS.ProcessEnv): MatrixEnvConfig {
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

export function resolveMatrixConfigForAccount(
  cfg: CoreConfig,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const matrix = resolveMatrixBaseConfig(cfg);
  const account = findMatrixAccountConfig(cfg, accountId) ?? {};
  const normalizedAccountId = normalizeAccountId(accountId);
  const suppressInactivePasswordSecretRef = hasConfiguredMatrixAccessTokenSource({
    cfg,
    env,
    accountId: normalizedAccountId,
  });
  const fieldReadOptions = {
    env,
    config: cfg,
  };
  const scopedEnv = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
  const globalEnv = resolveGlobalMatrixEnvConfig(env);
  const accountField = (field: MatrixConfigStringField) =>
    readMatrixAccountConfigField(cfg, normalizedAccountId, account, field, {
      ...fieldReadOptions,
      suppressSecretRef: field === "password" ? suppressInactivePasswordSecretRef : undefined,
    });
  const resolvedStrings = resolveMatrixAccountStringValues({
    accountId: normalizedAccountId,
    account: {
      homeserver: accountField("homeserver"),
      userId: accountField("userId"),
      accessToken: accountField("accessToken"),
      password: accountField("password"),
      deviceId: accountField("deviceId"),
      deviceName: accountField("deviceName"),
    },
    scopedEnv,
    channel: {
      homeserver: readMatrixBaseConfigField(matrix, "homeserver", fieldReadOptions),
      userId: readMatrixBaseConfigField(matrix, "userId", fieldReadOptions),
      accessToken: readMatrixBaseConfigField(matrix, "accessToken", fieldReadOptions),
      password: readMatrixBaseConfigField(matrix, "password", {
        ...fieldReadOptions,
        suppressSecretRef: suppressInactivePasswordSecretRef,
      }),
      deviceId: readMatrixBaseConfigField(matrix, "deviceId", fieldReadOptions),
      deviceName: readMatrixBaseConfigField(matrix, "deviceName", fieldReadOptions),
    },
    globalEnv,
  });

  const accountInitialSyncLimit = clampMatrixInitialSyncLimit(account.initialSyncLimit);
  const initialSyncLimit =
    accountInitialSyncLimit ?? clampMatrixInitialSyncLimit(matrix.initialSyncLimit);
  const encryption =
    typeof account.encryption === "boolean" ? account.encryption : (matrix.encryption ?? false);
  const allowPrivateNetwork =
    isPrivateNetworkOptInEnabled(account) || isPrivateNetworkOptInEnabled(matrix)
      ? true
      : undefined;

  return {
    homeserver: resolvedStrings.homeserver,
    userId: resolvedStrings.userId,
    accessToken: resolvedStrings.accessToken || undefined,
    password: resolvedStrings.password || undefined,
    deviceId: resolvedStrings.deviceId || undefined,
    deviceName: resolvedStrings.deviceName || undefined,
    initialSyncLimit,
    encryption,
    ...buildMatrixNetworkFields({
      allowPrivateNetwork,
      proxy: account.proxy ?? matrix.proxy,
    }),
  };
}
