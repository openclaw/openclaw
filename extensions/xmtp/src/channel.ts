/**
 * XMTP channel adapter for OpenClaw gateway.
 * Uses @xmtp/agent-sdk to listen for messages and forward them via the reply pipeline.
 */

import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type PluginRuntime,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  ensureXmtpConfigured,
  listXmtpAccountIds,
  resolveDefaultXmtpAccountId,
  resolveXmtpAccount,
  setAccountPublicAddress,
  type CoreConfig,
  type ResolvedXmtpAccount,
} from "./accounts.js";
import { xmtpMessageActions } from "./actions.js";
import { xmtpChannelConfigSchema } from "./config-schema.js";
import { createAgentFromAccount } from "./lib/xmtp-client.js";
import { xmtpOnboardingAdapter } from "./onboarding.js";
import { getClientForAccount, setClientForAccount, xmtpOutbound } from "./outbound.js";
import { getXmtpRuntime } from "./runtime.js";

type RuntimeLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const CHANNEL_ID = "xmtp";

const meta = {
  id: CHANNEL_ID,
  label: "XMTP",
  selectionLabel: "XMTP (Agent SDK)",
  docsPath: "/channels/xmtp",
  docsLabel: "xmtp",
  blurb: "Decentralized messaging via XMTP protocol",
  systemImage: "network",
  order: 76,
  aliases: [CHANNEL_ID],
};

function normalizeXmtpAddress(raw: string): string {
  let s = raw.trim();
  if (s.toLowerCase().startsWith("xmtp:")) {
    s = s.slice("xmtp:".length).trim();
  }
  return s;
}

function normalizeXmtpMessagingTarget(raw: string): string | undefined {
  const s = normalizeXmtpAddress(raw);
  return s || undefined;
}

function isGroupAllowed(params: { account: ResolvedXmtpAccount; conversationId: string }): boolean {
  const { account, conversationId } = params;
  const policy = account.config.groupPolicy ?? "open";
  if (policy === "open") {
    return true;
  }
  if (policy === "disabled") {
    return false;
  }
  const groups = account.config.groups ?? [];
  return groups.includes("*") || groups.includes(conversationId);
}

async function handleInboundMessage(
  account: ResolvedXmtpAccount,
  sender: string,
  conversationId: string,
  content: string,
  messageId: string | undefined,
  runtime: PluginRuntime,
  log?: RuntimeLogger,
) {
  if (account.debug) {
    log?.info(
      `[${account.accountId}] Inbound from ${sender.slice(0, 12)}: ${content.slice(0, 50)}`,
    );
  }

  if (!isGroupAllowed({ account, conversationId })) {
    if (account.debug) {
      log?.info(
        `[${account.accountId}] Dropped message from disallowed conversation ${conversationId.slice(0, 12)}`,
      );
    }
    return;
  }

  const cfg = runtime.config.loadConfig();
  const rawBody = content;
  const isDirect = conversationId === sender;

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isDirect ? "dm" : "group",
      id: conversationId,
    },
  });

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "XMTP",
    from: sender.slice(0, 12),
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `xmtp:${sender}`,
    To: `xmtp:${conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirect ? "direct" : "group",
    ConversationLabel: conversationId.slice(0, 12),
    SenderName: undefined,
    SenderId: sender,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: messageId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `xmtp:${conversationId}`,
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        await deliverXmtpReply({
          payload,
          conversationId,
          accountId: account.accountId,
          runtime,
          log,
          tableMode,
        });
      },
      onError: (err, info) => {
        const msg = String(err);
        if (msg.includes("XMTP agent not available")) {
          log?.info(`[${account.accountId}] XMTP ${info.kind} reply skipped (agent unavailable).`);
          return;
        }
        log?.error(`[${account.accountId}] XMTP ${info.kind} reply failed: ${msg}`);
      },
    },
  });
}

async function deliverXmtpReply(params: {
  payload: ReplyPayload;
  conversationId: string;
  accountId: string;
  runtime: PluginRuntime;
  log?: RuntimeLogger;
  tableMode?: "off" | "plain" | "markdown" | "bullets" | "code";
}): Promise<void> {
  const { payload, conversationId, accountId, runtime, log, tableMode = "code" } = params;

  const agent = getClientForAccount(accountId);
  if (!agent) {
    throw new Error("XMTP agent not available");
  }

  const text = runtime.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  if (text) {
    const conversation = await agent.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId.slice(0, 12)}...`);
    }

    const cfg = runtime.config.loadConfig();
    const chunkLimit = runtime.channel.text.resolveTextChunkLimit({
      cfg,
      channel: CHANNEL_ID,
      accountId,
    });
    const chunks = runtime.channel.text.chunkMarkdownText(text, chunkLimit);

    for (const chunk of chunks) {
      try {
        await conversation.sendText(chunk);
      } catch (err) {
        log?.error(`[${accountId}] Failed to send message: ${String(err)}`);
        throw err;
      }
    }
  }
}

async function stopAgent(accountId: string, log?: RuntimeLogger): Promise<void> {
  const agent = getClientForAccount(accountId);
  if (agent) {
    try {
      await agent.stop();
    } catch (err) {
      log?.error(`[${accountId}] Error stopping agent: ${String(err)}`);
    }
    setClientForAccount(accountId, null);
  }
}

export const xmtpPlugin: ChannelPlugin<ResolvedXmtpAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.xmtp"] },
  gatewayMethods: ["xmtp.setup", "xmtp.setup.status", "xmtp.setup.complete", "xmtp.setup.cancel"],
  configSchema: xmtpChannelConfigSchema,
  onboarding: xmtpOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listXmtpAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveXmtpAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultXmtpAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        clearBaseFields: ["name", "walletKey", "dbEncryptionKey", "env", "debug", "publicAddress"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      env: account.env,
      publicAddress: account.publicAddress || undefined,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.xmtp.dmPolicy",
      allowFromPath: "channels.xmtp.allowFrom",
    }),
  },
  pairing: {
    idLabel: "address",
    normalizeAllowEntry: (entry) => normalizeXmtpAddress(entry),
  },
  messaging: {
    normalizeTarget: normalizeXmtpMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const t = raw.trim();
        if (!t) {
          return false;
        }
        return (t.length >= 20 && /^0x[0-9a-fA-F]+$/.test(t)) || t.includes("/");
      },
      hint: "<address or conversation topic>",
    },
  },
  actions: xmtpMessageActions,
  agentPrompt: {
    messageToolHints: () => [
      "- XMTP targets are wallet addresses or conversation topics. Use `to=<address>` for `action=send`.",
    ],
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  outbound: xmtpOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: CHANNEL_ID,
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      env: snapshot.env ?? "production",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.walletKey || !account.dbEncryptionKey) {
        return {
          ok: false,
          error: "Not configured: walletKey and dbEncryptionKey required.",
        };
      }
      try {
        const runtime = getXmtpRuntime();
        const stateDir = runtime.state.resolveStateDir();
        const agent = await createAgentFromAccount(account, stateDir);
        const limit = timeoutMs ?? 10000;
        await Promise.race([
          agent.start(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Probe timed out")), limit),
          ),
        ]);
        await agent.stop();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      env: account.env,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, setStatus, log } = ctx;
      ensureXmtpConfigured(account);
      const runtime = getXmtpRuntime();

      if (!account.config.publicAddress) {
        const cfg = runtime.config.loadConfig();
        const next = setAccountPublicAddress(cfg, account.accountId, account.publicAddress);
        await runtime.config.writeConfigFile(next);
        log?.info(`[${account.accountId}] backfilled publicAddress to config`);
      }

      setStatus({ accountId: account.accountId, env: account.env });

      log?.info(
        `[${account.accountId}] starting XMTP provider (env: ${account.env}, agent: ${account.publicAddress})`,
      );

      const stateDir = runtime.state.resolveStateDir();
      const agent = await createAgentFromAccount(account, stateDir);

      agent.on("text", async (msgCtx) => {
        log?.info(
          `[${account.accountId}] text event: ${JSON.stringify({ content: msgCtx.message?.content?.slice(0, 50), id: msgCtx.message?.id })}`,
        );
        const sender = await msgCtx.getSenderAddress();
        const conversation = msgCtx.conversation;
        const conversationId = conversation?.id as string;
        handleInboundMessage(
          account,
          sender,
          conversationId,
          msgCtx.message.content,
          msgCtx.message.id,
          runtime,
          log,
        ).catch((err) => {
          log?.error(`[${account.accountId}] Message handling failed: ${String(err)}`);
        });
      });

      await agent.start();
      setClientForAccount(account.accountId, agent);

      log?.info(`[${account.accountId}] XMTP provider started`);

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          void stopAgent(account.accountId, log).finally(resolve);
        };
        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    stopAccount: async (ctx) => {
      const { account, log } = ctx;
      log?.info(`[${account.accountId}] stopping XMTP provider`);
      await stopAgent(account.accountId, log);
    },
  },
};
