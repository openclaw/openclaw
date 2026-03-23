import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveAccount } from "./accounts.js";
import { dispatchSynologyChatInboundTurn } from "./inbound-turn.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import { createWebhookHandler, type WebhookHandlerDeps } from "./webhook-handler.js";

const CHANNEL_ID = "synology-chat";

type SynologyGatewayLog = WebhookHandlerDeps["log"];

const activeRouteUnregisters = new Map<string, () => void>();

export function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

export function validateSynologyGatewayAccountStartup(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  accountId: string;
  log?: SynologyGatewayLog;
}): { ok: true } | { ok: false } {
  const { cfg, accountId, account, log } = params;
  if (!account.enabled) {
    log?.info?.(`Synology Chat account ${accountId} is disabled, skipping`);
    return { ok: false };
  }
  if (!account.token || !account.incomingUrl) {
    log?.warn?.(
      `Synology Chat account ${accountId} not fully configured (missing token or incomingUrl)`,
    );
    return { ok: false };
  }
  if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
    log?.warn?.(
      `Synology Chat account ${accountId} has dmPolicy=allowlist but empty allowedUserIds; refusing to start route`,
    );
    return { ok: false };
  }
  const accountIds = listCombinedAccountIds({
    configuredAccountIds: Object.keys(cfg.channels?.["synology-chat"]?.accounts ?? {}),
    implicitAccountId:
      cfg.channels?.["synology-chat"]?.token || process.env.SYNOLOGY_CHAT_TOKEN
        ? DEFAULT_ACCOUNT_ID
        : undefined,
  });
  const isMultiAccount = accountIds.length > 1;
  if (
    isMultiAccount &&
    accountId !== DEFAULT_ACCOUNT_ID &&
    !account.hasExplicitWebhookPath &&
    !account.dangerouslyAllowInheritedWebhookPath
  ) {
    log?.warn?.(
      `Synology Chat account ${accountId} must set an explicit webhookPath in multi-account setups; refusing inherited shared path. Set channels.synology-chat.accounts.${accountId}.webhookPath or opt in with dangerouslyAllowInheritedWebhookPath=true.`,
    );
    return { ok: false };
  }
  const conflictingAccounts = accountIds.filter((candidateId) => {
    if (candidateId === accountId) {
      return false;
    }
    const candidate = resolveAccount(cfg, candidateId);
    return candidate.enabled && candidate.webhookPath === account.webhookPath;
  });
  if (conflictingAccounts.length > 0) {
    log?.warn?.(
      `Synology Chat account ${accountId} conflicts on webhookPath ${account.webhookPath} with ${conflictingAccounts.join(", ")}; refusing to start ambiguous shared route.`,
    );
    return { ok: false };
  }
  return { ok: true };
}

export function registerSynologyWebhookRoute(params: {
  account: ResolvedSynologyChatAccount;
  accountId: string;
  log?: SynologyGatewayLog;
}): () => void {
  const { account, accountId, log } = params;
  const routeKey = `${accountId}:${account.webhookPath}`;
  const prevUnregister = activeRouteUnregisters.get(routeKey);
  if (prevUnregister) {
    log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
    prevUnregister();
    activeRouteUnregisters.delete(routeKey);
  }

  const handler = createWebhookHandler({
    account,
    deliver: async (msg) => await dispatchSynologyChatInboundTurn({ account, msg, log }),
    log,
  });
  const unregister = registerPluginHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    pluginId: CHANNEL_ID,
    accountId: account.accountId,
    log: (msg: string) => log?.info?.(msg),
    handler,
  });
  activeRouteUnregisters.set(routeKey, unregister);
  return () => {
    unregister();
    activeRouteUnregisters.delete(routeKey);
  };
}
