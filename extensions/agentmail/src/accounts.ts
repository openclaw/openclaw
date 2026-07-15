import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveAccountEntry,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMailbox } from "./mailbox.js";
import type { AgentMailChannelConfig, ResolvedAgentMailAccount } from "./types.js";

const CHANNEL_ID = "agentmail";
const DEFAULT_WEBHOOK_PATH = "/webhooks/agentmail";
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

function getChannelConfig(cfg: OpenClawConfig): AgentMailChannelConfig | undefined {
  return cfg.channels?.[CHANNEL_ID] as AgentMailChannelConfig | undefined;
}

function hasBaseAccount(channel: AgentMailChannelConfig | undefined): boolean {
  return Boolean(
    channel?.inboxId || hasConfiguredSecretInput(channel?.apiKey) || process.env.AGENTMAIL_API_KEY,
  );
}

export function listAgentMailAccountIds(cfg: OpenClawConfig): string[] {
  const channel = getChannelConfig(cfg);
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channel?.accounts ?? {}),
    implicitAccountId: hasBaseAccount(channel) ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

export function resolveDefaultAgentMailAccountId(cfg: OpenClawConfig): string {
  const channel = getChannelConfig(cfg);
  return resolveListedDefaultAccountId({
    accountIds: listAgentMailAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(channel?.defaultAccount),
  });
}

function resolveSecret(params: { value: unknown; path: string; fallback?: string }): string {
  return (
    normalizeResolvedSecretInputString({
      value: params.value ?? params.fallback,
      path: params.path,
    }) ?? ""
  );
}

export function resolveAgentMailAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAgentMailAccount {
  const channel = getChannelConfig(cfg) ?? {};
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultAgentMailAccountId(cfg);
  const account = resolveAccountEntry(channel.accounts, id);
  const defaultAccount = id === DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<Record<string, unknown> & AgentMailChannelConfig>({
    channelConfig: { ...channel },
    accounts: channel.accounts,
    accountId: id,
    // A top-level path belongs to the implicit default account. Named accounts get their own
    // account-derived default unless they explicitly override webhookPath.
    omitKeys: defaultAccount ? ["defaultAccount"] : ["defaultAccount", "webhookPath"],
  });
  const fieldPath = (field: "apiKey" | "webhookSecret") =>
    defaultAccount ? `channels.agentmail.${field}` : `channels.agentmail.accounts.${id}.${field}`;
  const allowFrom = normalizeStringEntries(
    (Array.isArray(merged.allowFrom)
      ? merged.allowFrom
      : typeof merged.allowFrom === "string"
        ? merged.allowFrom.split(",")
        : []
    ).map((entry) => normalizeMailbox(String(entry))),
  );
  const mediaMaxMb =
    typeof merged.mediaMaxMb === "number" && Number.isFinite(merged.mediaMaxMb)
      ? merged.mediaMaxMb
      : DEFAULT_MEDIA_MAX_BYTES / (1024 * 1024);
  const configuredPath = merged.webhookPath?.trim();
  const apiVal = resolveSecret({
    value: merged.apiKey,
    fallback: defaultAccount ? process.env.AGENTMAIL_API_KEY : undefined,
    path: fieldPath("apiKey"),
  });
  const hookVal = resolveSecret({
    value: merged.webhookSecret,
    fallback: defaultAccount ? process.env.AGENTMAIL_WEBHOOK_SECRET : undefined,
    path: fieldPath("webhookSecret"),
  });
  return {
    accountId: id,
    enabled: channel.enabled !== false && account?.enabled !== false,
    apiKey: apiVal,
    inboxId: merged.inboxId?.trim() ?? "",
    webhookSecret: hookVal,
    webhookPath:
      configuredPath ||
      (defaultAccount ? DEFAULT_WEBHOOK_PATH : `${DEFAULT_WEBHOOK_PATH}/${encodeURIComponent(id)}`),
    dmPolicy: merged.dmPolicy ?? "allowlist",
    allowFrom,
    mediaMaxBytes: Math.max(1, Math.floor(mediaMaxMb * 1024 * 1024)),
  };
}

export function isAgentMailAccountConfigured(account: ResolvedAgentMailAccount): boolean {
  return Boolean(account.apiKey && account.inboxId);
}

export function inspectAgentMailAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveAgentMailAccount(cfg, accountId);
  return {
    enabled: account.enabled,
    configured: isAgentMailAccountConfigured(account),
    inboxId: account.inboxId,
    ingressMode: account.webhookSecret ? "webhook" : "websocket",
    webhookPath: account.webhookPath,
  };
}
