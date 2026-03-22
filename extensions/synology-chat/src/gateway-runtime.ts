import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
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
  account: ResolvedSynologyChatAccount;
  accountId: string;
  log?: SynologyGatewayLog;
}): { ok: true } | { ok: false } {
  const { accountId, account, log } = params;
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
    replaceExisting: true,
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
