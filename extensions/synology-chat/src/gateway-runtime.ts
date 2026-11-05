import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendMessage } from "./client.js";
import { resolveSynologyPublicWebhookRouteKey } from "./hosted-media-route.js";
import { getSynologyRuntime } from "./runtime.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import {
  createWebhookHandler,
  processSynologyWebhookIngressEvent,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";
import { createSynologyIngressMonitor } from "./webhook-ingress.js";

const CHANNEL_ID = "synology-chat";

type SynologyGatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
type SynologyGatewayStartupIssueCode =
  | "disabled"
  | "missing-credentials"
  | "empty-allowlist"
  | "empty-open-allowlist"
  | "inherited-shared-webhook-path"
  | "duplicate-webhook-path"
  | "duplicate-webhook-url";
type SynologyGatewayStartupIssue = ReturnType<typeof buildStartupIssue>;

const activeRouteCleanups = new Map<string, () => Promise<void>>();

function buildStartupIssue(
  code: SynologyGatewayStartupIssueCode,
  message: string,
  logLevel: "info" | "warn" = "warn",
) {
  return { code, logLevel, message };
}

function createUnknownArgsLogAdapter(
  log?: SynologyGatewayLog,
): WebhookHandlerDeps["log"] | undefined {
  if (!log) {
    return undefined;
  }
  const formatArg = (value: unknown): string =>
    typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const formatArgs = (args: unknown[]): string => args.map(formatArg).filter(Boolean).join(": ");
  return {
    info: (...args) => log.info?.(formatArgs(args)),
    warn: (...args) => log.warn?.(formatArgs(args)),
    error: (...args) => log.error?.(formatArgs(args)),
  };
}

function collectSynologyGatewayStartupIssues(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  accountId: string;
}): SynologyGatewayStartupIssue[] {
  const { cfg, account, accountId } = params;
  const issues: SynologyGatewayStartupIssue[] = [];

  if (!account.enabled) {
    issues.push(
      buildStartupIssue("disabled", `account ${accountId} is disabled, skipping`, "info"),
    );
    return issues;
  }
  if (!account.token || !account.incomingUrl) {
    issues.push(
      buildStartupIssue(
        "missing-credentials",
        `account ${accountId} not fully configured (missing token or incomingUrl)`,
      ),
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
    issues.push(
      buildStartupIssue(
        "empty-allowlist",
        `account ${accountId} has dmPolicy=allowlist but empty allowedUserIds; refusing to start route`,
      ),
    );
  }
  if (account.dmPolicy === "open" && account.allowedUserIds.length === 0) {
    issues.push(
      buildStartupIssue(
        "empty-open-allowlist",
        `account ${accountId} has dmPolicy=open but empty allowedUserIds; add allowedUserIds=["*"] for public DMs or set explicit user IDs`,
      ),
    );
  }

  const accountIds = listAccountIds(cfg);
  const isMultiAccount = accountIds.length > 1;
  if (
    isMultiAccount &&
    accountId !== DEFAULT_ACCOUNT_ID &&
    account.webhookPathSource === "inherited-base" &&
    !account.dangerouslyAllowInheritedWebhookPath
  ) {
    issues.push(
      buildStartupIssue(
        "inherited-shared-webhook-path",
        `account ${accountId} must set an explicit webhookPath in multi-account setups; refusing inherited shared path. Set channels.synology-chat.accounts.${accountId}.webhookPath or opt in with dangerouslyAllowInheritedWebhookPath=true.`,
      ),
    );
  }

  const conflictingAccounts: string[] = [];
  const conflictingPublicAccounts: string[] = [];
  const publicRouteKey = resolveSynologyPublicWebhookRouteKey(account.webhookUrl);
  for (const candidateId of accountIds) {
    if (candidateId === accountId) {
      continue;
    }
    const candidate = resolveAccount(cfg, candidateId);
    if (!candidate.enabled) {
      continue;
    }
    if (candidate.webhookPath === account.webhookPath) {
      conflictingAccounts.push(candidateId);
    }
    if (
      publicRouteKey &&
      resolveSynologyPublicWebhookRouteKey(candidate.webhookUrl) === publicRouteKey
    ) {
      conflictingPublicAccounts.push(candidateId);
    }
  }
  if (conflictingAccounts.length > 0) {
    issues.push(
      buildStartupIssue(
        "duplicate-webhook-path",
        `account ${accountId} conflicts on webhookPath ${account.webhookPath} with ${conflictingAccounts.join(", ")}; refusing to start ambiguous shared route.`,
      ),
    );
  }

  if (conflictingPublicAccounts.length > 0) {
    issues.push(
      buildStartupIssue(
        "duplicate-webhook-url",
        `account ${accountId} conflicts on webhookUrl with ${conflictingPublicAccounts.join(", ")}; refusing to start ambiguous public route. Set a unique externally reachable callback URL for each account.`,
      ),
    );
  }

  return issues;
}

export function collectSynologyGatewayRoutingFindings(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
}) {
  return collectSynologyGatewayStartupIssues({
    cfg: params.cfg,
    account: params.account,
    accountId: params.account.accountId,
  })
    .filter(
      (issue) =>
        issue.code === "inherited-shared-webhook-path" ||
        issue.code === "duplicate-webhook-path" ||
        issue.code === "duplicate-webhook-url",
    )
    .map((issue) => ({
      checkId: `channels.synology-chat.routing.${issue.code}`,
      severity: issue.code === "duplicate-webhook-url" ? ("critical" as const) : ("warn" as const),
      title: "Synology Chat security warning",
      detail: `Synology Chat: ${issue.message}`,
    }));
}

export function validateSynologyGatewayAccountStartup(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  accountId: string;
  log?: SynologyGatewayLog;
}): { ok: true } | { ok: false } {
  const issues = collectSynologyGatewayStartupIssues(params);
  if (issues.length > 0) {
    for (const issue of issues) {
      params.log?.[issue.logLevel]?.(`Synology Chat ${issue.message}`);
    }
    return { ok: false };
  }
  return { ok: true };
}

export async function registerSynologyWebhookRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  log?: SynologyGatewayLog;
  abortSignal?: AbortSignal;
}): Promise<() => Promise<void>> {
  const { cfg, account, log } = params;
  const routeKey = `${account.accountId}:${account.webhookPath}`;
  const previousCleanup = activeRouteCleanups.get(routeKey);
  if (previousCleanup) {
    log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
    await previousCleanup();
  }

  const logAdapter = createUnknownArgsLogAdapter(log);
  const ingress = createSynologyIngressMonitor({
    accountId: account.accountId,
    runtime: {
      error: (message) => log?.error?.(message),
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    dispatch: async (rawEvent, lifecycle) => {
      await processSynologyWebhookIngressEvent({
        account,
        rawEvent,
        lifecycle,
        log: logAdapter,
        deliver: async (msg, turnAdoptionLifecycle) => {
          const rt = getSynologyRuntime();
          // SAFETY: Routing and inbound preparation only read the host-validated config snapshot.
          const currentCfg = rt.config.current() as OpenClawConfig;

          // The Chat API user_id (for sending) may differ from the webhook
          // user_id (used for sessions/pairing). Use chatUserId for API calls.
          const sendUserId = msg.chatUserId ?? msg.from;
          const route = rt.channel.routing.resolveAgentRoute({
            cfg: currentCfg,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            peer: { kind: "direct", id: msg.from },
          });
          const sessionKey = buildAgentSessionKey({
            agentId: route.agentId,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            peer: { kind: "direct", id: msg.from },
            // Synology Chat supports multiple independent accounts on one gateway.
            // Keep direct-message sessions isolated per account and user.
            dmScope: "per-account-channel-peer",
            identityLinks: currentCfg.session?.identityLinks,
          });

          await rt.channel.inbound.run({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            raw: msg,
            ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
            adapter: {
              ingest: (message) => ({
                id: message.messageId,
                timestamp: Date.now(),
                rawText: message.body,
                textForAgent: message.body,
                textForCommands: message.body,
                raw: message,
              }),
              resolveTurn: async (input) => {
                const chatKind =
                  msg.chatType === "group" || msg.chatType === "channel" ? msg.chatType : "direct";
                const channelIngress = await msg.resolveChannelIngress({
                  agentId: route.agentId,
                  sessionKey,
                  messageId: input.id,
                  inboundEventKind: "user_request",
                });
                const msgCtx = rt.channel.inbound.buildContext({
                  channelIngress,
                  channel: CHANNEL_ID,
                  accountId: account.accountId,
                  messageId: input.id,
                  timestamp: input.timestamp,
                  from: `synology-chat:${msg.from}`,
                  sender: {
                    id: msg.from,
                    name: msg.senderName,
                  },
                  conversation: {
                    kind: chatKind,
                    id: msg.from,
                    label: msg.senderName || msg.from,
                  },
                  route: {
                    agentId: route.agentId,
                    dmScope: route.dmScope,
                    accountId: account.accountId,
                    routeSessionKey: sessionKey,
                    dispatchSessionKey: sessionKey,
                  },
                  reply: {
                    to: `synology-chat:${msg.from}`,
                  },
                  message: {
                    rawBody: input.rawText,
                    commandBody: input.textForCommands,
                    bodyForAgent: input.textForAgent,
                  },
                  extra: {
                    ChatType: msg.chatType,
                    CommandAuthorized: msg.commandAuthorized,
                  },
                });
                return {
                  cfg: currentCfg,
                  channel: CHANNEL_ID,
                  accountId: account.accountId,
                  route: {
                    agentId: route.agentId,
                    dmScope: route.dmScope,
                    sessionKey: route.sessionKey,
                  },
                  ctxPayload: msgCtx,
                  delivery: {
                    durable: () => ({
                      to: sendUserId,
                    }),
                    deliver: async (payload) => {
                      const text = payload.text;
                      const visibleReplySent = text
                        ? await sendMessage(
                            account.incomingUrl,
                            text,
                            sendUserId,
                            account.allowInsecureSsl,
                          )
                        : false;
                      return { visibleReplySent: Boolean(visibleReplySent) };
                    },
                  },
                  dispatcherOptions: {
                    onReplyStart: () => {
                      logAdapter?.info?.(`Agent reply started for ${msg.from}`);
                    },
                  },
                  record: {
                    onRecordError: (err) => {
                      logAdapter?.info?.(`Session metadata update failed for ${msg.from}`, err);
                    },
                  },
                };
              },
            },
          });
        },
      });
    },
  });
  ingress.start();
  const handler = createWebhookHandler({
    account,
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
    receive: ingress.receive,
    log: logAdapter,
  });
  let unregister: () => void;
  try {
    unregister = registerPluginHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      pluginId: CHANNEL_ID,
      accountId: account.accountId,
      log: (msg: string) => log?.info?.(msg),
      throwOnFailure: true,
      handler: async (req, res) => {
        const { tryHandleSynologyHostedMediaRequest } = await import("./outbound-media.js");
        if (await tryHandleSynologyHostedMediaRequest(req, res, account)) {
          return true;
        }
        return await handler(req, res);
      },
    });
  } catch (error) {
    await ingress.stop();
    throw error;
  }
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        unregister();
      } finally {
        try {
          await ingress.stop();
        } finally {
          // A replacement route may already own this key; never delete its cleanup.
          if (activeRouteCleanups.get(routeKey) === cleanup) {
            activeRouteCleanups.delete(routeKey);
          }
        }
      }
    })();
    return cleanupPromise;
  };
  activeRouteCleanups.set(routeKey, cleanup);
  return cleanup;
}
