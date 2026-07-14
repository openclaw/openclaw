// Rcs plugin module implements gateway behavior.
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { createRcsIngressSpool, type RcsIngressLog } from "./ingress-spool.js";
import type { ResolvedRcsAccount } from "./types.js";
import {
  createRcsSharedTwilioWebhookHandler,
  createRcsStatusCallbackHandler,
  createRcsWebhookHandler,
  type RcsWebhookHandlerParams,
} from "./webhook.js";

const CHANNEL_ID = "rcs";

const activeRoutes = new Map<string, () => void>();
const activeRoutePaths = new Map<string, string>();
const activeAccounts = new Map<string, RcsActiveAccount>();
const pendingAccountStops = new Map<string, Promise<void>>();

type RcsActiveAccount = {
  ingress: ReturnType<typeof createRcsIngressSpool>;
  unregisterRoutes: () => void;
  ready: Promise<void>;
  stopTask?: Promise<void>;
};

type RcsGatewayLog = RcsIngressLog;

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function statusCallbackPath(webhookPath: string): string {
  return `${normalizeWebhookPath(webhookPath).replace(/\/+$/, "")}/status`;
}

export function collectRcsStartupWarnings(account: ResolvedRcsAccount): string[] {
  const warnings: string[] = [];
  if (
    !account.accountSid ||
    !account.authToken ||
    (!account.messagingServiceSid && !account.senderId)
  ) {
    warnings.push(
      "- RCS: accountSid, authToken, and messagingServiceSid or senderId are required.",
    );
  }
  if (!account.publicWebhookUrl && !account.dangerouslyDisableSignatureValidation) {
    warnings.push(
      "- RCS: publicWebhookUrl is required for Twilio signature validation. Set dangerouslyDisableSignatureValidation=true only for local testing.",
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- RCS: dmPolicy=allowlist with empty allowFrom rejects every sender.");
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- RCS: dmPolicy=open should set allowFrom=["*"] or explicit sender numbers.');
  }
  if (account.transport === "rcs-preferred") {
    warnings.push(
      "- RCS: transport=rcs-preferred can deliver over SMS/MMS fallback; delivery is not guaranteed to be RCS.",
    );
  }
  if (account.sharedWebhookPath && !account.smsForwardWebhookPath) {
    warnings.push("- RCS: smsForwardWebhookPath is required when sharedWebhookPath is set.");
  }
  if (
    account.sharedWebhookPath &&
    normalizeWebhookPath(account.sharedWebhookPath) === normalizeWebhookPath(account.webhookPath)
  ) {
    warnings.push(
      "- RCS: a sharedWebhookPath distinct from webhookPath is required; the shared Twilio route cannot replace the dedicated RCS route.",
    );
  }
  if (
    account.sharedWebhookPath &&
    account.smsForwardWebhookPath &&
    normalizeWebhookPath(account.smsForwardWebhookPath) ===
      normalizeWebhookPath(account.sharedWebhookPath)
  ) {
    warnings.push(
      "- RCS: an smsForwardWebhookPath distinct from sharedWebhookPath is required; forwarding the shared webhook to itself would loop.",
    );
  }
  if (
    account.sharedWebhookPath &&
    !account.sharedWebhookPublicUrl &&
    !account.dangerouslyDisableSignatureValidation
  ) {
    warnings.push(
      "- RCS: sharedWebhookPublicUrl is required for shared Twilio webhook signature validation.",
    );
  }
  return warnings;
}

function registerRoute(params: {
  path: string;
  accountId: string;
  handler: Parameters<typeof registerPluginHttpRoute>[0]["handler"];
  log?: RcsGatewayLog;
}): () => void {
  const key = `${params.accountId}:${params.path}`;
  const currentPathOwner = activeRoutePaths.get(params.path);
  if (currentPathOwner && currentPathOwner !== params.accountId) {
    throw new Error(
      `RCS webhook path ${params.path} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${params.accountId}.`,
    );
  }
  activeRoutes.get(key)?.();
  activeRoutePaths.delete(params.path);
  const handle = registerPluginHttpRoute({
    path: params.path,
    auth: "plugin",
    conflictPolicy: "throw",
    pluginId: CHANNEL_ID,
    accountId: params.accountId,
    log: (msg) => params.log?.info?.(msg),
    handler: params.handler,
  });
  activeRoutes.set(key, handle);
  activeRoutePaths.set(params.path, params.accountId);
  return () => {
    handle();
    activeRoutes.delete(key);
    if (activeRoutePaths.get(params.path) === params.accountId) {
      activeRoutePaths.delete(params.path);
    }
  };
}

function registerRcsWebhookRoutes(params: {
  cfg: RcsWebhookHandlerParams["cfg"];
  account: ResolvedRcsAccount;
  ingress: RcsWebhookHandlerParams["ingress"];
  log?: RcsGatewayLog;
}): () => void {
  const webhookPath = normalizeWebhookPath(params.account.webhookPath);
  // Register the routes one at a time so a collision on any of them (inbound,
  // status, or the shared Twilio path) rolls back the ones already registered
  // instead of leaving the account half-wired before the failure propagates.
  const registered: Array<() => void> = [];
  const rollback = () => {
    for (const unregister of registered.toReversed()) {
      unregister();
    }
  };
  try {
    registered.push(
      registerRoute({
        path: webhookPath,
        accountId: params.account.accountId,
        handler: createRcsWebhookHandler(params),
        log: params.log,
      }),
    );
    if (params.account.statusCallbacks) {
      registered.push(
        registerRoute({
          path: statusCallbackPath(webhookPath),
          accountId: params.account.accountId,
          handler: createRcsStatusCallbackHandler(params),
          log: params.log,
        }),
      );
    }
    if (params.account.sharedWebhookPath && params.account.smsForwardWebhookPath) {
      registered.push(
        registerRoute({
          path: normalizeWebhookPath(params.account.sharedWebhookPath),
          accountId: params.account.accountId,
          handler: createRcsSharedTwilioWebhookHandler({
            ...params,
            sharedPublicWebhookUrl:
              params.account.sharedWebhookPublicUrl || params.account.publicWebhookUrl,
            smsForwardWebhookPath: params.account.smsForwardWebhookPath,
          }),
          log: params.log,
        }),
      );
    }
  } catch (err) {
    rollback();
    throw err;
  }
  return rollback;
}

function stopRcsWebhookAccount(accountId: string, active: RcsActiveAccount): Promise<void> {
  if (active.stopTask) {
    return active.stopTask;
  }
  const pauseTask = active.ingress.pause();
  active.unregisterRoutes();
  if (activeAccounts.get(accountId) === active) {
    activeAccounts.delete(accountId);
  }
  const previousStop = pendingAccountStops.get(accountId) ?? Promise.resolve();
  const stopTask = Promise.all([previousStop, active.ready, pauseTask]).then(
    () => active.ingress.stop(),
    async (error: unknown) => {
      await Promise.allSettled([active.ingress.stop()]);
      throw error;
    },
  );
  active.stopTask = stopTask;
  pendingAccountStops.set(accountId, stopTask);
  const clear = () => {
    if (pendingAccountStops.get(accountId) === stopTask) {
      pendingAccountStops.delete(accountId);
    }
  };
  void stopTask.then(clear, clear);
  return stopTask;
}

export async function startRcsGatewayAccount(params: {
  cfg: RcsWebhookHandlerParams["cfg"];
  account: ResolvedRcsAccount;
  channelRuntime: Parameters<typeof createRcsIngressSpool>[0]["channelRuntime"];
  abortSignal: AbortSignal;
  log?: RcsGatewayLog;
}) {
  if (!params.account.enabled) {
    params.log?.info?.(`RCS account ${params.account.accountId} is disabled`);
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectRcsStartupWarnings(params.account);
  if (warnings.some((warning) => warning.includes("required"))) {
    for (const warning of warnings) {
      params.log?.warn?.(warning);
    }
    return waitUntilAbort(params.abortSignal);
  }
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  const currentAccount = activeAccounts.get(params.account.accountId);
  const predecessorStop = currentAccount
    ? stopRcsWebhookAccount(params.account.accountId, currentAccount)
    : (pendingAccountStops.get(params.account.accountId) ?? Promise.resolve());
  const ingress = createRcsIngressSpool({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    ...(params.log ? { log: params.log } : {}),
  });
  let unregisterRoutes: () => void;
  try {
    unregisterRoutes = registerRcsWebhookRoutes({
      cfg: params.cfg,
      account: params.account,
      ingress,
      ...(params.log ? { log: params.log } : {}),
    });
  } catch (error) {
    await Promise.allSettled([predecessorStop, ingress.stop()]);
    throw error;
  }
  const active: RcsActiveAccount = {
    ingress,
    unregisterRoutes,
    ready: Promise.resolve(),
  };
  activeAccounts.set(params.account.accountId, active);
  active.ready = predecessorStop.then(() => {
    if (activeAccounts.get(params.account.accountId) === active && !active.stopTask) {
      ingress.start();
    }
  });
  const stop = () => stopRcsWebhookAccount(params.account.accountId, active);
  const readinessAbort = new AbortController();
  const lifecycle = waitUntilAbort(
    AbortSignal.any([params.abortSignal, readinessAbort.signal]),
    stop,
  );
  try {
    await active.ready;
  } catch (error) {
    readinessAbort.abort();
    await Promise.allSettled([lifecycle]);
    throw error;
  }
  params.log?.info?.(
    `Registered RCS webhook route ${params.account.webhookPath} for account ${params.account.accountId}`,
  );
  return lifecycle;
}
