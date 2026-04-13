import type { OpenClawPluginConfigSchema, PluginLogger } from "../api.js";
import {
  normalizeOptionalString,
  normalizeSecretInput,
  normalizeWebhookPath,
  resolveConfiguredSecretInputString,
  type OpenClawConfig,
} from "../runtime-api.js";

export const M365_PLUGIN_ID = "m365";
export const M365_DEFAULT_ACCOUNT_ID = "default";
export const M365_DEFAULT_FOLDER = "inbox";
export const M365_DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const M365_DEFAULT_TOKEN_BASE_URL = "https://login.microsoftonline.com";
export const M365_DEFAULT_TRIAGE_LIMIT = 10;
export const M365_DEFAULT_TRIAGE_SINCE_MINUTES = 24 * 60;
export const M365_DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const M365_DEFAULT_APPROVAL_PREVIEW_CHARS = 1200;
export const M365_DEFAULT_MAX_BODY_CHARS = 12_000;
export const M365_DEFAULT_WEBHOOK_PATH = "/plugins/m365/notifications";
export const M365_DEFAULT_WEBHOOK_EXPIRATION_MINUTES = 60 * 24 * 2;
export const M365_DEFAULT_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const AUTH_MODES = new Set(["app-only", "delegated"]);

export type M365AuthMode = "app-only" | "delegated";

export type M365SecretRef = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};

export type M365SecretInput = string | M365SecretRef;

export type M365RawAccountConfig = {
  enabled?: boolean;
  authMode?: string;
  identityId?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: M365SecretInput;
  mailboxUserId?: string;
  mailbox?: string;
  folder?: string;
  maxBodyChars?: number;
  allowedReplyDomains?: string[];
};

export type M365RawPluginConfig = {
  enabled?: boolean;
  defaultAccountId?: string;
  authMode?: string;
  identityId?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: M365SecretInput;
  mailboxUserId?: string;
  graphBaseUrl?: string;
  tokenBaseUrl?: string;
  allowedMailboxes?: string[];
  mailWriteScopeProbeMailboxUserId?: string;
  allowedCalendars?: string[];
  accounts?: Record<string, M365RawAccountConfig>;
  triage?: {
    limit?: number;
    sinceMinutes?: number;
    unreadOnly?: boolean;
  };
  approval?: {
    timeoutMs?: number;
    previewChars?: number;
    teamsUserIds?: string[];
  };
  webhook?: {
    enabled?: boolean;
    path?: string;
    clientState?: M365SecretInput;
    notificationUrl?: string;
    expirationMinutes?: number;
    maxBodyBytes?: number;
  };
};

export type M365ResolvedAccountConfig = {
  accountId: string;
  enabled: boolean;
  authMode: M365AuthMode;
  identityId: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  mailboxUserId: string;
  folder: string;
  maxBodyChars: number;
  allowedReplyDomains: string[];
};

export type M365ResolvedPluginConfig = {
  enabled: boolean;
  defaultAccountId: string;
  graphBaseUrl: string;
  tokenBaseUrl: string;
  accounts: Record<string, M365ResolvedAccountConfig>;
  triage: {
    limit: number;
    sinceMinutes: number;
    unreadOnly: boolean;
  };
  allowedMailboxes: string[];
  mailWriteScopeProbeMailboxUserId?: string;
  allowedCalendars: string[];
  approval: {
    timeoutMs: number;
    previewChars: number;
    teamsUserIds: string[];
  };
  webhook: {
    enabled: boolean;
    path: string;
    clientState?: string;
    notificationUrl?: string;
    expirationMinutes: number;
    maxBodyBytes: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeAuthMode(value: unknown, fallback: M365AuthMode): M365AuthMode {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized && AUTH_MODES.has(normalized)) {
    return normalized as M365AuthMode;
  }
  return fallback;
}

function normalizeUrl(value: unknown, fallback: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  try {
    const url = new URL(normalized);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function isSecretRef(value: unknown): value is M365SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.provider === "string" &&
    Boolean(value.provider.trim()) &&
    typeof value.id === "string" &&
    Boolean(value.id.trim())
  );
}

function readSecretInput(value: unknown): M365SecretInput | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (isSecretRef(value)) {
    return value;
  }
  return undefined;
}

function parseRawAccount(value: unknown): M365RawAccountConfig {
  if (!isRecord(value)) {
    return {};
  }
  return {
    enabled: readBoolean(value.enabled),
    authMode: normalizeOptionalString(value.authMode),
    identityId: normalizeOptionalString(value.identityId),
    tenantId: normalizeOptionalString(value.tenantId),
    clientId: normalizeOptionalString(value.clientId),
    clientSecret: readSecretInput(value.clientSecret),
    mailboxUserId: normalizeOptionalString(value.mailboxUserId),
    mailbox: normalizeOptionalString(value.mailbox),
    folder: normalizeOptionalString(value.folder),
    maxBodyChars:
      typeof value.maxBodyChars === "number" && Number.isFinite(value.maxBodyChars)
        ? Math.floor(value.maxBodyChars)
        : undefined,
    allowedReplyDomains: readStringArray(value.allowedReplyDomains),
  };
}

export function parseM365PluginConfig(input: unknown): M365RawPluginConfig {
  const raw = isRecord(input) ? input : {};
  const accounts: Record<string, M365RawAccountConfig> = {};
  if (isRecord(raw.accounts)) {
    for (const [accountId, accountConfig] of Object.entries(raw.accounts).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const normalizedAccountId = normalizeOptionalString(accountId);
      if (!normalizedAccountId) {
        continue;
      }
      accounts[normalizedAccountId] = parseRawAccount(accountConfig);
    }
  }

  return {
    enabled: readBoolean(raw.enabled),
    defaultAccountId: normalizeOptionalString(raw.defaultAccountId),
    authMode: normalizeOptionalString(raw.authMode),
    identityId: normalizeOptionalString(raw.identityId),
    tenantId: normalizeOptionalString(raw.tenantId),
    clientId: normalizeOptionalString(raw.clientId),
    clientSecret: readSecretInput(raw.clientSecret),
    mailboxUserId: normalizeOptionalString(raw.mailboxUserId),
    graphBaseUrl: normalizeOptionalString(raw.graphBaseUrl),
    tokenBaseUrl: normalizeOptionalString(raw.tokenBaseUrl),
    allowedMailboxes: readStringArray(raw.allowedMailboxes),
    mailWriteScopeProbeMailboxUserId: normalizeOptionalString(raw.mailWriteScopeProbeMailboxUserId),
    allowedCalendars: readStringArray(raw.allowedCalendars),
    accounts,
    triage: isRecord(raw.triage)
      ? {
          limit:
            typeof raw.triage.limit === "number" && Number.isFinite(raw.triage.limit)
              ? Math.floor(raw.triage.limit)
              : undefined,
          sinceMinutes:
            typeof raw.triage.sinceMinutes === "number" && Number.isFinite(raw.triage.sinceMinutes)
              ? Math.floor(raw.triage.sinceMinutes)
              : undefined,
          unreadOnly: readBoolean(raw.triage.unreadOnly),
        }
      : undefined,
    approval: isRecord(raw.approval)
      ? {
          timeoutMs:
            typeof raw.approval.timeoutMs === "number" && Number.isFinite(raw.approval.timeoutMs)
              ? Math.floor(raw.approval.timeoutMs)
              : undefined,
          previewChars:
            typeof raw.approval.previewChars === "number" &&
            Number.isFinite(raw.approval.previewChars)
              ? Math.floor(raw.approval.previewChars)
              : undefined,
          teamsUserIds: readStringArray(raw.approval.teamsUserIds),
        }
      : undefined,
    webhook: isRecord(raw.webhook)
      ? {
          enabled: readBoolean(raw.webhook.enabled),
          path: normalizeOptionalString(raw.webhook.path),
          clientState: readSecretInput(raw.webhook.clientState),
          notificationUrl: normalizeOptionalString(raw.webhook.notificationUrl),
          expirationMinutes:
            typeof raw.webhook.expirationMinutes === "number" &&
            Number.isFinite(raw.webhook.expirationMinutes)
              ? Math.floor(raw.webhook.expirationMinutes)
              : undefined,
          maxBodyBytes:
            typeof raw.webhook.maxBodyBytes === "number" &&
            Number.isFinite(raw.webhook.maxBodyBytes)
              ? Math.floor(raw.webhook.maxBodyBytes)
              : undefined,
        }
      : undefined,
  };
}

async function resolveSecretInput(params: {
  value: M365SecretInput | undefined;
  path: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  logger?: PluginLogger;
}): Promise<string | undefined> {
  if (!params.value) {
    return undefined;
  }
  const resolution = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value: params.value,
    path: params.path,
  });
  const secret = normalizeSecretInput(resolution.value);
  if (!secret && resolution.unresolvedRefReason) {
    params.logger?.warn?.(
      `[m365] unresolved secret at ${params.path}: ${resolution.unresolvedRefReason}`,
    );
  }
  return secret || undefined;
}

function createImplicitDefaultAccount(raw: M365RawPluginConfig, env: NodeJS.ProcessEnv) {
  const mailboxUserId = raw.mailboxUserId ?? normalizeOptionalString(env.M365_MAILBOX_USER_ID);
  if (!mailboxUserId) {
    return {};
  }
  return {
    [M365_DEFAULT_ACCOUNT_ID]: {
      mailboxUserId,
    },
  };
}

export async function resolveM365PluginConfig(params: {
  pluginConfig: unknown;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
}): Promise<M365ResolvedPluginConfig> {
  const env = params.env ?? process.env;
  const raw = parseM365PluginConfig(params.pluginConfig);
  const rootClientSecret =
    (await resolveSecretInput({
      value: raw.clientSecret,
      path: "plugins.entries.m365.config.clientSecret",
      config: params.config,
      env,
      logger: params.logger,
    })) || normalizeSecretInput(env.M365_CLIENT_SECRET);

  const rootAuthMode = normalizeAuthMode(raw.authMode, "app-only");
  const rawAccounts =
    Object.keys(raw.accounts ?? {}).length > 0
      ? (raw.accounts ?? {})
      : createImplicitDefaultAccount(raw, env);
  const accounts: Record<string, M365ResolvedAccountConfig> = {};

  for (const [accountId, account] of Object.entries(rawAccounts).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (account.enabled === false) {
      continue;
    }
    const mailboxUserId =
      account.mailboxUserId ??
      account.mailbox ??
      raw.mailboxUserId ??
      normalizeOptionalString(env.M365_MAILBOX_USER_ID);
    if (!mailboxUserId) {
      params.logger?.warn?.(`[m365] skipping account ${accountId}: mailboxUserId is missing`);
      continue;
    }

    const accountClientSecret =
      (await resolveSecretInput({
        value: account.clientSecret,
        path: `plugins.entries.m365.config.accounts.${accountId}.clientSecret`,
        config: params.config,
        env,
        logger: params.logger,
      })) || rootClientSecret;

    accounts[accountId] = {
      accountId,
      enabled: true,
      authMode: normalizeAuthMode(account.authMode, rootAuthMode),
      identityId: account.identityId ?? raw.identityId ?? accountId,
      tenantId: account.tenantId ?? raw.tenantId ?? normalizeOptionalString(env.M365_TENANT_ID),
      clientId: account.clientId ?? raw.clientId ?? normalizeOptionalString(env.M365_CLIENT_ID),
      clientSecret: accountClientSecret || undefined,
      mailboxUserId,
      folder: account.folder ?? M365_DEFAULT_FOLDER,
      maxBodyChars: readBoundedInteger(
        account.maxBodyChars,
        M365_DEFAULT_MAX_BODY_CHARS,
        256,
        65_536,
      ),
      allowedReplyDomains: account.allowedReplyDomains ?? [],
    };
  }

  const sortedAccountIds = Object.keys(accounts).toSorted((a, b) => a.localeCompare(b));
  const defaultAccountId =
    raw.defaultAccountId && accounts[raw.defaultAccountId]
      ? raw.defaultAccountId
      : (sortedAccountIds[0] ?? M365_DEFAULT_ACCOUNT_ID);
  const webhookClientState = await resolveSecretInput({
    value: raw.webhook?.clientState,
    path: "plugins.entries.m365.config.webhook.clientState",
    config: params.config,
    env,
    logger: params.logger,
  });

  return {
    enabled: raw.enabled !== false,
    defaultAccountId,
    graphBaseUrl: normalizeUrl(raw.graphBaseUrl, M365_DEFAULT_GRAPH_BASE_URL),
    tokenBaseUrl: normalizeUrl(raw.tokenBaseUrl, M365_DEFAULT_TOKEN_BASE_URL),
    accounts,
    triage: {
      limit: readBoundedInteger(raw.triage?.limit, M365_DEFAULT_TRIAGE_LIMIT, 1, 50),
      sinceMinutes: readBoundedInteger(
        raw.triage?.sinceMinutes,
        M365_DEFAULT_TRIAGE_SINCE_MINUTES,
        1,
        43_200,
      ),
      unreadOnly: raw.triage?.unreadOnly ?? true,
    },
    allowedMailboxes: readStringArray(raw.allowedMailboxes).map((entry) => entry.toLowerCase()),
    mailWriteScopeProbeMailboxUserId: normalizeOptionalString(
      raw.mailWriteScopeProbeMailboxUserId,
    )?.toLowerCase(),
    allowedCalendars: readStringArray(raw.allowedCalendars).map((entry) => entry.toLowerCase()),
    approval: {
      timeoutMs: readBoundedInteger(
        raw.approval?.timeoutMs,
        M365_DEFAULT_APPROVAL_TIMEOUT_MS,
        1000,
        600_000,
      ),
      previewChars: readBoundedInteger(
        raw.approval?.previewChars,
        M365_DEFAULT_APPROVAL_PREVIEW_CHARS,
        100,
        4000,
      ),
      teamsUserIds: readStringArray(raw.approval?.teamsUserIds),
    },
    webhook: {
      enabled: raw.webhook?.enabled === true,
      path: normalizeWebhookPath(raw.webhook?.path ?? M365_DEFAULT_WEBHOOK_PATH),
      clientState: webhookClientState,
      notificationUrl: raw.webhook?.notificationUrl,
      expirationMinutes: readBoundedInteger(
        raw.webhook?.expirationMinutes,
        M365_DEFAULT_WEBHOOK_EXPIRATION_MINUTES,
        15,
        4230,
      ),
      maxBodyBytes: readBoundedInteger(
        raw.webhook?.maxBodyBytes,
        M365_DEFAULT_WEBHOOK_MAX_BODY_BYTES,
        1024,
        1024 * 1024,
      ),
    },
  };
}

export function resolveM365Account(
  config: M365ResolvedPluginConfig,
  accountId?: string,
): M365ResolvedAccountConfig {
  const requested = normalizeOptionalString(accountId) ?? config.defaultAccountId;
  const account = config.accounts[requested];
  if (account) {
    return account;
  }
  const available = Object.keys(config.accounts).toSorted((a, b) => a.localeCompare(b));
  if (available.length === 0) {
    throw new Error("No M365 Outlook accounts are configured.");
  }
  throw new Error(
    `Unknown M365 Outlook account "${requested}". Available: ${available.join(", ")}`,
  );
}

export function resolveM365AccountForIdentity(
  config: M365ResolvedPluginConfig,
  identityOrAccountId?: string,
): M365ResolvedAccountConfig {
  const requested = normalizeOptionalString(identityOrAccountId);
  if (!requested) {
    return resolveM365Account(config);
  }
  const direct = config.accounts[requested];
  if (direct) {
    return direct;
  }
  const normalizedIdentity = requested.toLowerCase();
  const byIdentity = Object.values(config.accounts).find(
    (account) => account.identityId.toLowerCase() === normalizedIdentity,
  );
  if (byIdentity) {
    return byIdentity;
  }
  return resolveM365Account(config, requested);
}

export const m365PluginConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    return { success: true, data: parseM365PluginConfig(value) };
  },
  parse(value: unknown) {
    return parseM365PluginConfig(value);
  },
};
