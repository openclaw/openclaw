import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
import { resolveMatrixAccountStringValues } from "../auth-precedence.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import {
  findMatrixAccountConfig,
  resolveMatrixAccountConfig,
  resolveMatrixBaseConfig,
} from "./account-config.js";
import { resolveGlobalMatrixEnvConfig, resolveScopedMatrixEnvConfig } from "./client/env-auth.js";
import {
  credentialsMatchConfig,
  loadMatrixCredentials,
  loadMatrixCredentialsAsync,
} from "./credentials-read.js";
import type { MatrixStoredCredentials } from "./credentials-state.js";

export type ResolvedMatrixAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  config: MatrixConfig;
};

function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function resolveMatrixAccountAuthView(params: {
  cfg: CoreConfig;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
} {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const matrix = resolveMatrixBaseConfig(params.cfg);
  const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
  const resolvedStrings = resolveMatrixAccountStringValues({
    accountId: normalizedAccountId,
    account: {
      homeserver: clean(account.homeserver),
      userId: clean(account.userId),
      accessToken: typeof account.accessToken === "string" ? clean(account.accessToken) : "",
      password: typeof account.password === "string" ? clean(account.password) : "",
      deviceId: clean(account.deviceId),
      deviceName: clean(account.deviceName),
    },
    scopedEnv: resolveScopedMatrixEnvConfig(normalizedAccountId, params.env),
    channel: {
      homeserver: clean(matrix.homeserver),
      userId: clean(matrix.userId),
      accessToken: typeof matrix.accessToken === "string" ? clean(matrix.accessToken) : "",
      password: typeof matrix.password === "string" ? clean(matrix.password) : "",
      deviceId: clean(matrix.deviceId),
      deviceName: clean(matrix.deviceName),
    },
    globalEnv: resolveGlobalMatrixEnvConfig(params.env),
  });
  return {
    homeserver: resolvedStrings.homeserver,
    userId: resolvedStrings.userId,
    accessToken: resolvedStrings.accessToken || undefined,
    password: resolvedStrings.password || undefined,
  };
}

function resolveMatrixAccountUserId(
  authView: ReturnType<typeof resolveMatrixAccountAuthView>,
  stored: MatrixStoredCredentials | null,
): string | null {
  const configuredUserId = authView.userId.trim();
  if (configuredUserId) {
    return configuredUserId;
  }
  if (!stored) {
    return null;
  }
  if (authView.homeserver && stored.homeserver !== authView.homeserver) {
    return null;
  }
  if (authView.accessToken && stored.accessToken !== authView.accessToken) {
    return null;
  }
  return stored.userId.trim() || null;
}

export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = resolveConfiguredMatrixAccountIds(cfg, process.env);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
}

export async function resolveConfiguredMatrixBotUserIds(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
}): Promise<Set<string>> {
  const env = { ...(params.env ?? process.env) };
  const currentAccountId = normalizeAccountId(params.accountId);
  const accountIds = new Set([
    ...resolveConfiguredMatrixAccountIds(params.cfg, env),
    DEFAULT_ACCOUNT_ID,
  ]);
  // Capture config/env facts before storage yields; each identity uses one credential observation.
  const accounts = [...accountIds]
    .filter((accountId) => normalizeAccountId(accountId) !== currentAccountId)
    .map((accountId) => prepareMatrixAccount({ cfg: params.cfg, accountId, env }));
  const ids = new Set<string>();
  for (const prepared of accounts) {
    if (params.abortSignal?.aborted) {
      break;
    }
    const stored = await loadMatrixCredentialsAsync(env, prepared.account.accountId);
    if (!isMatrixAccountConfigured(prepared, stored)) {
      continue;
    }
    const userId = resolveMatrixAccountUserId(prepared.authView, stored);
    if (userId) {
      ids.add(userId);
    }
  }
  return ids;
}

function prepareMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMatrixAccountId(params.cfg),
  );
  const matrixBase = resolveMatrixBaseConfig(params.cfg);
  const base = resolveMatrixAccountConfig({ cfg: params.cfg, accountId, env });
  const explicitAuthConfig =
    accountId === DEFAULT_ACCOUNT_ID
      ? base
      : (findMatrixAccountConfig(params.cfg, accountId) ?? {});
  const enabled = base.enabled !== false && matrixBase.enabled !== false;

  const authView = resolveMatrixAccountAuthView({
    cfg: params.cfg,
    accountId,
    env,
  });
  const hasHomeserver = Boolean(authView.homeserver);
  const hasUserId = Boolean(authView.userId);
  const hasAccessToken =
    Boolean(authView.accessToken) || hasConfiguredSecretInput(explicitAuthConfig.accessToken);
  const hasPassword = Boolean(authView.password);
  const hasPasswordAuth =
    hasUserId && (hasPassword || hasConfiguredSecretInput(explicitAuthConfig.password));
  return {
    authView,
    hasHomeserver,
    hasConfiguredAuth: hasAccessToken || hasPasswordAuth,
    account: {
      accountId,
      enabled,
      name: normalizeOptionalString(base.name),
      homeserver: authView.homeserver || undefined,
      userId: authView.userId || undefined,
      config: base,
    },
  };
}

function isMatrixAccountConfigured(
  prepared: ReturnType<typeof prepareMatrixAccount>,
  stored: MatrixStoredCredentials | null,
): boolean {
  const { authView } = prepared;
  const hasStored =
    stored && authView.homeserver
      ? credentialsMatchConfig(stored, {
          homeserver: authView.homeserver,
          userId: authView.userId || "",
        })
      : false;
  return prepared.hasHomeserver && (prepared.hasConfiguredAuth || hasStored);
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedMatrixAccount {
  const prepared = prepareMatrixAccount(params);
  const stored = loadMatrixCredentials(params.env ?? process.env, prepared.account.accountId);
  return { ...prepared.account, configured: isMatrixAccountConfigured(prepared, stored) };
}

export { resolveMatrixAccountConfig } from "./account-config.js";
