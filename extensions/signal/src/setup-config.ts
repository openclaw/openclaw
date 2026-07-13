import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  type ChannelSetupAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SignalAccountConfig } from "./account-types.js";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import type { SignalApiMode } from "./client-adapter.js";

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const DEFAULT_SIGNAL_NATIVE_HTTP_HOST = "127.0.0.1";
const DEFAULT_SIGNAL_NATIVE_HTTP_PORT = 8080;
const SIGNAL_SETUP_INHERITED_ROOT_KEYS = new Set([
  "account",
  "accountUuid",
  "cliPath",
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "autoStart",
]);
const SIGNAL_SETUP_DEFAULT_ACCOUNT_ROOT_KEYS = new Set([
  ...SIGNAL_SETUP_INHERITED_ROOT_KEYS,
  "name",
]);

export const SIGNAL_SETUP_TRANSPORT_KEY = "signalTransport";
export const SIGNAL_SETUP_NATIVE_PORT_KEY = "signalNativePort";
export const SIGNAL_PHONE_NUMBER_EXAMPLE = "+15555550123";

export type SignalSetupTransport = "native" | "external-native";

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const phoneInput = trimmed.replace(/^signal:/i, "").trim();
  // Setup accepts formatting punctuation, but embedded or duplicate pluses are invalid input.
  const plusCount = phoneInput.match(/\+/g)?.length ?? 0;
  if (plusCount > 1 || (plusCount === 1 && !phoneInput.startsWith("+"))) {
    return null;
  }
  const normalized = normalizeE164(phoneInput);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  existingApiMode?: SignalApiMode;
  existingAutoStart?: boolean;
  existingHttpHost?: string;
  existingHttpPort?: number;
  existingHttpUrl?: string;
}) {
  const externalDaemonPatch = input.httpUrl ? { autoStart: false, apiMode: "auto" as const } : {};
  const shouldResetNativeEndpoint = shouldResetSignalNativeEndpoint(input);
  const nativeDaemonPatch =
    !input.httpUrl && (input.cliPath || input.httpHost || input.httpPort)
      ? {
          autoStart: true,
          apiMode: "native" as const,
          ...(shouldResetNativeEndpoint
            ? {
                httpUrl: "",
                httpHost: input.httpHost ?? DEFAULT_SIGNAL_NATIVE_HTTP_HOST,
                httpPort: input.httpPort ? Number(input.httpPort) : DEFAULT_SIGNAL_NATIVE_HTTP_PORT,
              }
            : {}),
          ...(!shouldResetNativeEndpoint && input.httpHost ? { httpHost: input.httpHost } : {}),
          ...(!shouldResetNativeEndpoint && input.httpPort
            ? { httpPort: Number(input.httpPort) }
            : {}),
        }
      : {};
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
    ...externalDaemonPatch,
    ...nativeDaemonPatch,
  };
}

function shouldResetSignalNativeEndpoint(params: {
  existingApiMode?: SignalApiMode;
  existingAutoStart?: boolean;
  existingHttpUrl?: string;
}): boolean {
  return (
    params.existingApiMode === "container" ||
    params.existingAutoStart === false ||
    Boolean(params.existingHttpUrl)
  );
}

function buildSignalSetupPatchForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Parameters<NonNullable<ChannelSetupAdapter["applyAccountConfig"]>>[0]["input"];
}) {
  const existingAccount = resolveSignalAccount(params).config;
  const patch = buildSignalSetupPatch({
    ...params.input,
    existingApiMode: existingAccount.apiMode,
    existingAutoStart: existingAccount.autoStart,
    existingHttpHost: normalizeOptionalString(existingAccount.httpHost),
    existingHttpPort: existingAccount.httpPort,
    existingHttpUrl: normalizeOptionalString(existingAccount.httpUrl),
  });
  const isAccountScoped =
    params.accountId !== DEFAULT_ACCOUNT_ID || shouldScopeDefaultSignalSetupPatch(params);
  if (patch.autoStart !== true || !isAccountScoped || params.input.httpPort != null) {
    return patch;
  }
  const preferredPort = resolveSignalNativeSetupPreferredPort({
    cfg: params.cfg,
    accountId: params.accountId,
    existingAccount,
  });
  return {
    ...patch,
    httpHost:
      normalizeOptionalString(patch.httpHost) ??
      normalizeOptionalString(existingAccount.httpHost) ??
      DEFAULT_SIGNAL_NATIVE_HTTP_HOST,
    httpPort: resolveSignalNativeSetupHttpPort({
      cfg: params.cfg,
      accountId: params.accountId,
      preferredPort,
    }),
  };
}

export function buildNativeSignalSetupPatch(params: {
  accountId: string;
  scopeDefaultToAccount?: boolean;
  existingApiMode?: SignalApiMode;
  existingAutoStart?: boolean;
  existingHttpHost?: string;
  existingHttpPort?: number;
  existingHttpUrl?: string;
  account?: string;
  cliPath?: string;
  configPath?: string;
  nativeHttpPort?: number;
}): Record<string, unknown> {
  const shouldResetNativeEndpoint = shouldResetSignalNativeEndpoint(params);
  const defaultPatch = {
    ...(params.account ? { account: params.account } : {}),
    ...(params.cliPath ? { cliPath: params.cliPath } : {}),
    autoStart: true,
    ...(shouldResetNativeEndpoint ? { apiMode: "native" } : {}),
    httpUrl: undefined,
    httpHost: shouldResetNativeEndpoint ? undefined : params.existingHttpHost,
    httpPort: shouldResetNativeEndpoint ? undefined : params.existingHttpPort,
    configPath: params.configPath ?? undefined,
  };
  if (params.accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccount) {
    return defaultPatch;
  }
  return {
    ...(params.account ? { account: params.account } : {}),
    ...(params.cliPath ? { cliPath: params.cliPath } : {}),
    autoStart: true,
    apiMode: "native",
    httpUrl: "",
    httpHost: shouldResetNativeEndpoint
      ? DEFAULT_SIGNAL_NATIVE_HTTP_HOST
      : (params.existingHttpHost ?? DEFAULT_SIGNAL_NATIVE_HTTP_HOST),
    httpPort: shouldResetNativeEndpoint
      ? (params.nativeHttpPort ?? DEFAULT_SIGNAL_NATIVE_HTTP_PORT)
      : (params.nativeHttpPort ?? params.existingHttpPort ?? DEFAULT_SIGNAL_NATIVE_HTTP_PORT),
    configPath: params.configPath ?? "",
  };
}

export function resolveSignalNativeSetupHttpPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  preferredPort?: number;
}): number {
  const reservedPorts = new Set<number>();
  for (const accountId of listSignalAccountIds(params.cfg)) {
    if (accountId === params.accountId) {
      continue;
    }
    const account = resolveSignalAccount({ cfg: params.cfg, accountId });
    const accountConfig = resolveAccountEntry<SignalAccountConfig>(
      params.cfg.channels?.signal?.accounts,
      accountId,
    );
    const autoStart = account.config.autoStart ?? !normalizeOptionalString(account.config.httpUrl);
    // Setup re-enables the channel, so only an account-level opt-out makes a port reusable.
    if (accountConfig?.enabled === false || !autoStart) {
      continue;
    }
    reservedPorts.add(account.config.httpPort ?? DEFAULT_SIGNAL_NATIVE_HTTP_PORT);
  }
  if (params.preferredPort && !reservedPorts.has(params.preferredPort)) {
    return params.preferredPort;
  }
  let port = DEFAULT_SIGNAL_NATIVE_HTTP_PORT;
  while (reservedPorts.has(port)) {
    port += 1;
  }
  return port;
}

export function resolveSignalNativeSetupPreferredPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  existingAccount: Pick<SignalAccountConfig, "apiMode" | "autoStart" | "httpPort" | "httpUrl">;
}): number | undefined {
  const usesImplicitManagedNativeDefaults =
    (params.existingAccount.apiMode == null || params.existingAccount.apiMode === "auto") &&
    params.existingAccount.autoStart == null &&
    !normalizeOptionalString(params.existingAccount.httpUrl);
  if (
    params.existingAccount.apiMode !== "native" &&
    params.existingAccount.autoStart !== true &&
    !usesImplicitManagedNativeDefaults
  ) {
    return undefined;
  }
  // The default account may still own its native port at the channel root.
  // Named accounts must preserve only an explicit override, or they can inherit another daemon's port.
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    return params.existingAccount.httpPort;
  }
  return params.cfg.channels?.signal?.accounts?.[params.accountId]?.httpPort;
}

function hasSignalAccountEntries(cfg: OpenClawConfig): boolean {
  const accounts = cfg.channels?.signal?.accounts;
  return Boolean(accounts && typeof accounts === "object" && Object.keys(accounts).length > 0);
}

export function shouldScopeDefaultSignalSetupPatch(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): boolean {
  return params.accountId === DEFAULT_ACCOUNT_ID && hasSignalAccountEntries(params.cfg);
}

function cloneSignalSetupConfigValue(value: unknown): unknown {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function preserveInheritedSignalSetupFields(params: {
  channelConfig: Record<string, unknown>;
  accounts: Record<string, Record<string, unknown>>;
}): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(params.accounts).map(([accountId, account]) => {
      let nextAccount = account;
      for (const key of SIGNAL_SETUP_INHERITED_ROOT_KEYS) {
        if (Object.hasOwn(account, key) || !Object.hasOwn(params.channelConfig, key)) {
          continue;
        }
        if (nextAccount === account) {
          nextAccount = { ...account };
        }
        nextAccount[key] = cloneSignalSetupConfigValue(params.channelConfig[key]);
      }
      return [accountId, nextAccount];
    }),
  );
}

function copySignalSetupAccountScopedRootFields(channelConfig: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const key of SIGNAL_SETUP_DEFAULT_ACCOUNT_ROOT_KEYS) {
    if (Object.hasOwn(channelConfig, key)) {
      fields[key] = cloneSignalSetupConfigValue(channelConfig[key]);
    }
  }
  return fields;
}

export function patchSignalSetupConfigForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  if (!shouldScopeDefaultSignalSetupPatch(params)) {
    return patchChannelConfigForAccount({ ...params, channel });
  }
  const channelConfig = params.cfg.channels?.signal ?? {};
  const accounts = channelConfig.accounts ?? {};
  const preservedAccounts = preserveInheritedSignalSetupFields({ channelConfig, accounts });
  const existingDefault = {
    ...copySignalSetupAccountScopedRootFields(channelConfig),
    ...preservedAccounts[DEFAULT_ACCOUNT_ID],
  };
  const nextChannel = { ...channelConfig };
  for (const key of SIGNAL_SETUP_DEFAULT_ACCOUNT_ROOT_KEYS) {
    delete nextChannel[key as keyof typeof nextChannel];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      signal: {
        ...nextChannel,
        enabled: true,
        accounts: {
          ...preservedAccounts,
          [DEFAULT_ACCOUNT_ID]: {
            ...existingDefault,
            enabled: true,
            ...params.patch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function resolveSignalSetupTransportFromConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): SignalSetupTransport {
  const account = resolveSignalAccount(params).config;
  if (account.autoStart === true) {
    return "native";
  }
  return normalizeOptionalString(account.httpUrl) || account.autoStart === false
    ? "external-native"
    : "native";
}

export const resolveSignalSetupChoiceFromConfig = resolveSignalSetupTransportFromConfig;

export function resolveSignalSetupTransportFromCredentialValues(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}): SignalSetupTransport {
  const value = params.credentialValues[SIGNAL_SETUP_TRANSPORT_KEY];
  return value === "native" || value === "external-native"
    ? value
    : resolveSignalSetupTransportFromConfig(params);
}

const signalSetupBaseAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ cfg, accountId, input }) => {
      const account =
        normalizeSignalAccountInput(input.signalNumber) ??
        normalizeOptionalString(resolveSignalAccount({ cfg, accountId }).config.account);
      const hasServerInput = Boolean(
        normalizeOptionalString(input.httpUrl) ||
        normalizeOptionalString(input.httpHost) ||
        input.httpPort != null ||
        normalizeOptionalString(input.cliPath),
      );
      return account || hasServerInput
        ? null
        : "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
    },
  }),
  buildPatch: buildSignalSetupPatch,
});

export const signalSetupAdapter: ChannelSetupAdapter = {
  ...signalSetupBaseAdapter,
  applyAccountConfig: (params) => {
    const patch = buildSignalSetupPatchForAccount(params);
    const named =
      signalSetupBaseAdapter.applyAccountName?.({
        cfg: params.cfg,
        accountId: params.accountId,
        name: params.input.name,
      }) ?? params.cfg;
    if (!shouldScopeDefaultSignalSetupPatch(params)) {
      return patchChannelConfigForAccount({
        cfg: named,
        channel,
        accountId: params.accountId,
        patch,
      });
    }
    return patchSignalSetupConfigForAccount({
      cfg: named,
      accountId: params.accountId,
      patch,
    });
  },
};
