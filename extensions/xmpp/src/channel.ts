import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createReplyPrefixOptions,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  resolveChannelMediaMaxBytes,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
  type ResolvedXmppAccount,
} from "./accounts.js";
import { XmppClient } from "./client.js";
import { XmppConfigSchema } from "./config-schema.js";
import { getXmppRuntime } from "./runtime.js";
import type { CoreConfig, XmppInboundMessage } from "./types.js";

const meta = {
  id: "xmpp",
  label: "XMPP",
  selectionLabel: "XMPP (plugin)",
  docsPath: "/channels/xmpp",
  docsLabel: "xmpp",
  blurb: "XMPP channel; install the plugin to enable.",
  order: 80,
  quickstartAllowFrom: true,
};

type XmppRuntimeState = {
  accountId: string;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
};

const clients = new Map<string, XmppClient>();
const runtimeByAccount = new Map<string, XmppRuntimeState>();

function createXmppRuntimeState(accountId: string): XmppRuntimeState {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

function getRuntimeState(accountId: string): XmppRuntimeState {
  let state = runtimeByAccount.get(accountId);
  if (!state) {
    state = createXmppRuntimeState(accountId);
    runtimeByAccount.set(accountId, state);
  }
  return state;
}

async function ensureClient(account: ResolvedXmppAccount): Promise<XmppClient> {
  const existing = clients.get(account.accountId);
  if (existing) {
    return existing;
  }

  const client = new XmppClient(account);
  client.on("message", (msg) => {
    const runtime = getXmppRuntime();
    try {
      const result = handleInboundMessage(account, msg);
      void Promise.resolve(result).catch((err) => {
        runtime.error?.(
          `[${account.accountId}] xmpp: failed to handle inbound message from=${msg.fromJid}: ${String(
            err,
          )}`,
        );
      });
    } catch (err) {
      runtime.error?.(
        `[${account.accountId}] xmpp: failed to handle inbound message from=${msg.fromJid}: ${String(
          err,
        )}`,
      );
    }
  });
  client.on("error", (err) => {
    const state = getRuntimeState(account.accountId);
    state.lastError = err.message;
    const runtime = getXmppRuntime();
    runtime.error?.(
      `[${account.accountId}] XMPP client error: ${
        (err as { message?: string })?.message ?? String(err)
      }`,
    );
  });

  try {
    const runtime = getXmppRuntime();
    runtime.log?.(
      `[${account.accountId}] starting XMPP client (${account.server}:${account.port}${
        account.tls ? " tls" : ""
      })`,
    );
    await client.connect();
    const state = getRuntimeState(account.accountId);
    state.running = true;
    state.lastStartAt = Date.now();
    state.lastError = null;
    runtime.log?.(
      `[${account.accountId}] XMPP client connected (${account.server}:${account.port}${
        account.tls ? " tls" : ""
      })`,
    );
  } catch (err) {
    const state = getRuntimeState(account.accountId);
    state.lastError = err instanceof Error ? err.message : String(err);
    const runtime = getXmppRuntime();
    runtime.error?.(
      `[${account.accountId}] failed to start XMPP client (${account.server}:${account.port}${
        account.tls ? " tls" : ""
      }): ${(err as { message?: string })?.message ?? String(err)}`,
    );
    throw err;
  }

  clients.set(account.accountId, client);
  return client;
}

async function stopClient(accountId: string): Promise<void> {
  const client = clients.get(accountId);
  if (!client) {
    return;
  }
  clients.delete(accountId);
  try {
    await client.disconnect();
  } catch {
    // Ignore disconnect errors.
  }
  const state = getRuntimeState(accountId);
  state.running = false;
  state.lastStopAt = Date.now();
  const runtime = getXmppRuntime();
  runtime.log?.(`[${accountId}] XMPP client stopped`);
}

async function handleInboundMessage(
  account: ResolvedXmppAccount,
  msg: XmppInboundMessage,
): Promise<void> {
  const runtime = getXmppRuntime();
  const core = getXmppRuntime();
  const cfg = runtime.config.loadConfig() as CoreConfig;
  const rawBody = msg.body?.trim() ?? "";
  const oobUrls = msg.oobUrls ?? [];

  if (!rawBody && oobUrls.length === 0) {
    return;
  }

  const effectiveBody = rawBody || (oobUrls.length > 0 ? oobUrls.join("\n") : "");

  const chatType = msg.isGroup ? "group" : "direct";
  const peerId = msg.isGroup ? msg.toJid : msg.fromJid;
  const timestamp = msg.timestamp ?? Date.now();

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "xmpp",
    accountId: account.accountId,
    peer: {
      kind: chatType,
      id: peerId,
    },
  });

  const fromLabel = msg.isGroup ? msg.toJid : msg.fromJid;

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "XMPP",
    from: fromLabel,
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: effectiveBody,
  });

  runtime.log?.(
    `[${account.accountId}] xmpp: inbound routed from=${msg.fromJid} to=${msg.toJid} chatType=${chatType} sessionKey=${route.sessionKey}`,
  );

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: effectiveBody,
    RawBody: effectiveBody,
    CommandBody: effectiveBody,
    From: msg.isGroup ? `xmpp:group:${msg.toJid}` : `xmpp:${msg.fromJid}`,
    To: `xmpp:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: undefined,
    SenderId: msg.fromJid,
    Provider: "xmpp",
    Surface: "xmpp",
    MessageSid: msg.messageId,
    Timestamp: timestamp,
    OriginatingChannel: "xmpp",
    OriginatingTo: `xmpp:${peerId}`,
    XmppChatState: msg.chatState,
    XmppReceiptForId: msg.receiptForId,
    CommandAuthorized: true,
    MediaUrls: oobUrls,
    MediaUrl: oobUrls[0],
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`xmpp: failed updating session meta: ${String(err)}`);
    },
  });

  const state = getRuntimeState(account.accountId);
  state.lastInboundAt = timestamp;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "xmpp",
    accountId: account.accountId,
  });

  const chatStatesEnabled = account.config.chatStatesEnabled ?? true;

  if (chatStatesEnabled) {
    const client = await ensureClient(account);
    const chatStateType = msg.isGroup ? "groupchat" : "chat";
    await client.sendChatState(peerId, "composing", chatStateType);
  }

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        const textPayload = (payload as { text?: string }).text ?? "";
        let mediaUrl =
          (payload as { mediaUrl?: string }).mediaUrl ??
          (payload as { mediaUrls?: string[] }).mediaUrls?.[0] ??
          undefined;

        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "xmpp",
          accountId: account.accountId,
        });
        const text = core.channel.text.convertMarkdownTables(textPayload ?? "", tableMode);

        const client = await ensureClient(account);
        const to = peerId;
        const maxBytes = resolveChannelMediaMaxBytes({
          cfg,
          resolveChannelLimitMb: ({ cfg: innerCfg, accountId: innerAccountId }) =>
            innerCfg.channels?.xmpp?.accounts?.[innerAccountId]?.mediaMaxMb ??
            innerCfg.channels?.xmpp?.mediaMaxMb,
          accountId: account.accountId,
        });

        const receiptsEnabled = account.config.receiptsEnabled ?? true;
        const httpUploadEnabled = account.config.httpUploadEnabled ?? true;

        let body = text;
        let oobUrls: { url: string; desc?: string }[] | undefined;

        if (mediaUrl && httpUploadEnabled) {
          try {
            const isHttpUrl = /^https?:\/\//i.test(mediaUrl);
            const uploaded = isHttpUrl
              ? await client.uploadMediaFromUrl({
                  mediaUrl,
                  maxBytes,
                  description: textPayload || undefined,
                })
              : await client.uploadMediaFromLocalPath({
                  filePath: mediaUrl,
                  maxBytes,
                  description: textPayload || undefined,
                });
            mediaUrl = uploaded.url;
            body = uploaded.url;
            oobUrls = [
              {
                url: uploaded.url,
                desc: textPayload || undefined,
              },
            ];
          } catch (err) {
            runtime.error?.(
              `[${account.accountId}] xmpp: HTTP upload failed for media: ${
                (err as { message?: string })?.message ?? String(err)
              }`,
            );
          }
        }

        if (mediaUrl && !oobUrls && !body) {
          body = mediaUrl;
        }

        if (mediaUrl && !oobUrls && body && body !== mediaUrl) {
          body = `${body}\n\n${mediaUrl}`;
        }

        await client.sendMessage(to, body, {
          type: msg.isGroup ? "groupchat" : "chat",
          requestReceipt: receiptsEnabled,
          oobUrls,
        });

        const runtimeState = getRuntimeState(account.accountId);
        runtimeState.lastOutboundAt = Date.now();

        runtime.log?.(
          `[${account.accountId}] xmpp: outbound reply to=${to} type=${chatType} hasMedia=${Boolean(
            mediaUrl,
          )} text=${textPayload.slice(0, 120)}`,
        );

        return {
          channel: "xmpp" as const,
          to,
          maxBytes,
        };
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] XMPP ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });

  if (chatStatesEnabled) {
    const client = await ensureClient(account);
    const chatStateType = msg.isGroup ? "groupchat" : "chat";
    await client.sendChatState(peerId, "active", chatStateType);
  }
}

export const xmppPlugin: ChannelPlugin<ResolvedXmppAccount> = {
  id: "xmpp",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.xmpp"] },
  configSchema: buildChannelConfigSchema(XmppConfigSchema),
  config: {
    listAccountIds: (cfg) => listXmppAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultXmppAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "xmpp",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "xmpp",
        accountId,
        clearBaseFields: ["jid", "server", "domain", "resource", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      jid: account.jid,
      server: account.server,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? "*" : entry))
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.xmpp?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.xmpp.accounts.${resolvedAccountId}.`
        : "channels.xmpp.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("xmpp"),
        normalizeEntry: (raw: string) => raw.replace(/^xmpp:/i, "").trim(),
      };
    },
  },
  messaging: {
    normalizeTarget: (target) => target.replace(/^xmpp:/i, "").trim(),
    targetResolver: {
      looksLikeId: (input) => input.includes("@"),
      hint: "<jid|xmpp:jid>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const runtime = getXmppRuntime();
      const coreCfg = (cfg ?? runtime.config.loadConfig()) as CoreConfig;
      const account = resolveXmppAccount({
        cfg: coreCfg,
        accountId,
      });

      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg: coreCfg,
        channel: "xmpp",
        accountId: account.accountId,
      });
      const formatted = runtime.channel.text.convertMarkdownTables(text ?? "", tableMode);

      const client = await ensureClient(account);
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: coreCfg,
        resolveChannelLimitMb: ({ cfg: innerCfg, accountId: innerAccountId }) =>
          innerCfg.channels?.xmpp?.accounts?.[innerAccountId]?.mediaMaxMb ??
          innerCfg.channels?.xmpp?.mediaMaxMb,
        accountId: account.accountId,
      });

      const receiptsEnabled = account.config.receiptsEnabled ?? true;

      const messageId = await client.sendMessage(to, formatted, {
        type: "chat",
        requestReceipt: receiptsEnabled,
      });

      const state = getRuntimeState(account.accountId);
      state.lastOutboundAt = Date.now();

      return {
        channel: "xmpp" as const,
        to,
        messageId,
        maxBytes,
      };
    },
    sendMedia: async ({ cfg, to, mediaUrl, mediaUrls, text, accountId }) => {
      const runtime = getXmppRuntime();
      const coreCfg = (cfg ?? runtime.config.loadConfig()) as CoreConfig;
      const account = resolveXmppAccount({
        cfg: coreCfg,
        accountId,
      });

      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg: coreCfg,
        channel: "xmpp",
        accountId: account.accountId,
      });
      const formatted = runtime.channel.text.convertMarkdownTables(text ?? "", tableMode);

      const client = await ensureClient(account);
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: coreCfg,
        resolveChannelLimitMb: ({ cfg: innerCfg, accountId: innerAccountId }) =>
          innerCfg.channels?.xmpp?.accounts?.[innerAccountId]?.mediaMaxMb ??
          innerCfg.channels?.xmpp?.mediaMaxMb,
        accountId: account.accountId,
      });

      const receiptsEnabled = account.config.receiptsEnabled ?? true;
      const httpUploadEnabled = account.config.httpUploadEnabled ?? true;

      const targetMediaUrl = mediaUrl ?? mediaUrls?.[0];
      if (!targetMediaUrl) {
        throw new Error("No media URL provided");
      }

      let body = formatted;
      let oobUrls: { url: string; desc?: string }[] | undefined;
      let finalMediaUrl = targetMediaUrl;

      if (httpUploadEnabled) {
        try {
          const isHttpUrl = /^https?:\/\//i.test(targetMediaUrl);
          const uploaded = isHttpUrl
            ? await client.uploadMediaFromUrl({
                mediaUrl: targetMediaUrl,
                maxBytes,
                description: text || undefined,
              })
            : await client.uploadMediaFromLocalPath({
                filePath: targetMediaUrl,
                maxBytes,
                description: text || undefined,
              });
          finalMediaUrl = uploaded.url;
          body = uploaded.url;
          oobUrls = [
            {
              url: uploaded.url,
              desc: text || undefined,
            },
          ];
        } catch (err) {
          runtime.error?.(
            `[${account.accountId}] xmpp: HTTP upload failed for media: ${
              (err as { message?: string })?.message ?? String(err)
            }`,
          );
        }
      }

      if (finalMediaUrl && !oobUrls && !body) {
        body = finalMediaUrl;
      }

      if (finalMediaUrl && !oobUrls && body && body !== finalMediaUrl) {
        body = `${body}\n\n${finalMediaUrl}`;
      }

      const messageId = await client.sendMessage(to, body, {
        type: "chat",
        requestReceipt: receiptsEnabled,
        oobUrls,
      });

      const state = getRuntimeState(account.accountId);
      state.lastOutboundAt = Date.now();

      return {
        channel: "xmpp" as const,
        to,
        messageId,
        maxBytes,
      };
    },
  },
  status: {
    defaultRuntime: createXmppRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("xmpp", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as ResolvedXmppAccount;
      ctx.setStatus({
        accountId: account.accountId,
      });
      ctx.log?.info(`[${account.accountId}] starting XMPP provider (${account.server})`);

      const client = await ensureClient(account);
      const abort = ctx.abortSignal as
        | {
            aborted?: boolean;
            addEventListener?: (type: "abort", listener: () => void) => void;
            removeEventListener?: (type: "abort", listener: () => void) => void;
          }
        | undefined;
      if (abort) {
        if (abort.aborted) {
          await stopClient(account.accountId);
          return;
        }
        const onAbort = () => {
          void stopClient(account.accountId);
          abort.removeEventListener?.("abort", onAbort);
        };
        abort.addEventListener?.("abort", onAbort);
      }

      return {
        client,
      };
    },
  },
};
