import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { createAgentMailCatchUpSession, createAgentMailCatchUpSupervisor } from "./catch-up.js";
import { createAgentMailClient } from "./client.js";
import { createAgentMailDurableInboundReceiveJournal } from "./durable-receive.js";
import { dispatchAgentMailInboundEvent, type AgentMailChannelRuntime } from "./inbound.js";
import { processAgentMailIngress, replayPendingAgentMailIngress } from "./ingress.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";
import { createAgentMailWebhookHandler } from "./webhook.js";
import { startAgentMailWebSocket } from "./websocket.js";

type ActiveRoute = { path: string; unregister: () => void };

const activeRoutes = new Map<string, ActiveRoute>();
const routeOwners = new Map<string, string>();

type GatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export function collectAgentMailStartupWarnings(account: ResolvedAgentMailAccount): string[] {
  const warnings: string[] = [];
  if (!account.apiKey || !account.inboxId) {
    warnings.push("- AgentMail: apiKey and inboxId are required.");
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- AgentMail: the default allowlist is empty, so every sender is denied.");
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- AgentMail: dmPolicy="open" requires allowFrom=["*"].');
  }
  return warnings;
}

export async function startAgentMailGatewayAccount(params: {
  cfg: OpenClawConfig;
  account: ResolvedAgentMailAccount;
  channelRuntime: AgentMailChannelRuntime;
  abortSignal: AbortSignal;
  log?: GatewayLog;
}): Promise<void> {
  if (!params.account.enabled) {
    return await waitUntilAbort(params.abortSignal);
  }
  const warnings = collectAgentMailStartupWarnings(params.account);
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  if (!params.account.apiKey || !params.account.inboxId) {
    return await waitUntilAbort(params.abortSignal);
  }
  const client = createAgentMailClient(params.account);

  const journal = createAgentMailDurableInboundReceiveJournal({
    accountId: params.account.accountId,
    inboxId: params.account.inboxId,
  });
  const dispatch = async (
    record: AgentMailIngressRecord,
    lifecycle: { onTurnAdopted: () => Promise<void> },
  ) =>
    await dispatchAgentMailInboundEvent({
      cfg: params.cfg,
      account: params.account,
      record,
      channelRuntime: params.channelRuntime,
      client,
      log: params.log,
      onTurnAdopted: lifecycle.onTurnAdopted,
    });
  const receive = async (record: AgentMailIngressRecord) => {
    await processAgentMailIngress({
      journal,
      record,
      dispatch,
      abortSignal: params.abortSignal,
    });
  };
  await replayPendingAgentMailIngress({ journal, dispatch, abortSignal: params.abortSignal });

  if (!params.account.webhookSecret) {
    params.log?.info?.(
      `Starting AgentMail WebSocket ingress for account ${params.account.accountId}`,
    );
    return await startAgentMailWebSocket({
      account: params.account,
      abortSignal: params.abortSignal,
      receive,
      log: params.log,
      client,
    });
  }

  const path = params.account.webhookPath.startsWith("/")
    ? params.account.webhookPath
    : `/${params.account.webhookPath}`;
  const owner = routeOwners.get(path);
  if (owner && owner !== params.account.accountId) {
    throw new Error(
      `AgentMail webhook path ${path} is already registered by account ${owner}; configure a distinct webhookPath.`,
    );
  }
  const previousRoute = activeRoutes.get(params.account.accountId);
  if (previousRoute) {
    previousRoute.unregister();
    if (routeOwners.get(previousRoute.path) === params.account.accountId) {
      routeOwners.delete(previousRoute.path);
    }
  }
  const catchUpSession = await createAgentMailCatchUpSession({
    account: params.account,
    client,
    log: params.log,
  });
  const catchUpSupervisor = createAgentMailCatchUpSupervisor({
    session: catchUpSession,
    receive,
    abortSignal: params.abortSignal,
    log: params.log,
  });
  const receiveWithRecovery = async (record: AgentMailIngressRecord) => {
    try {
      await receive(record);
    } catch (error) {
      // Provider retries remain useful, but REST recovery is the durable fallback if the provider
      // exhausts them while local admission is full or temporarily unavailable.
      catchUpSupervisor.request();
      throw error;
    }
  };
  const unregister = registerPluginHttpRoute({
    path,
    auth: "plugin",
    pluginId: "agentmail",
    accountId: params.account.accountId,
    handler: createAgentMailWebhookHandler({
      account: params.account,
      receive: receiveWithRecovery,
      log: params.log,
    }),
  });
  const activeRoute = { path, unregister };
  activeRoutes.set(params.account.accountId, activeRoute);
  routeOwners.set(path, params.account.accountId);
  params.log?.info?.(
    `Registered AgentMail webhook route ${path} for account ${params.account.accountId}`,
  );
  catchUpSupervisor.request();
  await waitUntilAbort(params.abortSignal, () => {
    // A replaced account invocation can abort later; it must not delete the newer registration.
    if (activeRoutes.get(params.account.accountId) === activeRoute) {
      unregister();
      activeRoutes.delete(params.account.accountId);
      if (routeOwners.get(path) === params.account.accountId) {
        routeOwners.delete(path);
      }
    }
  });
  await catchUpSupervisor.settle();
}
