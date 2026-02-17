import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  createReplyPrefixOptions,
  DEFAULT_ACCOUNT_ID,
  formatAllowlistMatchMeta,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistMatchSimple,
  resolveControlCommandGate,
  type ChannelPlugin,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { XmtpConfigSchema } from "./config-schema.js";
import { getXmtpRuntime } from "./runtime.js";
import {
  listXmtpAccountIds,
  resolveDefaultXmtpAccountId,
  resolveXmtpAccount,
  type ResolvedXmtpAccount,
} from "./types.js";
import { normalizeEthAddress, startXmtpBus, type XmtpBusHandle } from "./xmtp-bus.js";

const activeBuses = new Map<string, XmtpBusHandle>();

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  try {
    return normalizeEthAddress(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizeAllowEntries(entries: Array<string | number>): string[] {
  return entries
    .map((entry) => normalizeAllowEntry(String(entry)))
    .filter((entry) => entry.length > 0);
}

function previewText(text: string, limit = 200): string {
  return text.slice(0, limit).replace(/\n/g, "\\n");
}

export const xmtpPlugin: ChannelPlugin<ResolvedXmtpAccount> = {
  id: "xmtp",
  meta: {
    id: "xmtp",
    label: "XMTP",
    selectionLabel: "XMTP",
    docsPath: "/channels/xmtp",
    docsLabel: "xmtp",
    blurb: "E2E encrypted messaging via XMTP (wallet-to-wallet)",
    order: 101,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.xmtp"] },
  configSchema: buildChannelConfigSchema(XmtpConfigSchema),

  config: {
    listAccountIds: (cfg) => listXmtpAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveXmtpAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultXmtpAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      address: account.address,
      env: account.env,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveXmtpAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") return "*";
          try {
            return normalizeEthAddress(entry);
          } catch {
            return entry;
          }
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "ethAddress",
    normalizeAllowEntry: (entry) => {
      try {
        return normalizeEthAddress(entry);
      } catch {
        return entry;
      }
    },
    notifyApproval: async ({ id }) => {
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (!bus) {
        throw new Error(`XMTP bus not running for account ${DEFAULT_ACCOUNT_ID}`);
      }
      await bus.sendText(id, PAIRING_APPROVED_MESSAGE);
      getXmtpRuntime().channel.activity.record({
        channel: "xmtp",
        accountId: DEFAULT_ACCOUNT_ID,
        direction: "outbound",
      });
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.xmtp.dmPolicy",
      allowFromPath: "channels.xmtp.allowFrom",
      approveHint: formatPairingApproveHint("xmtp"),
      normalizeEntry: (raw) => {
        try {
          return normalizeEthAddress(raw.trim());
        } catch {
          return raw.trim();
        }
      },
    }),
  },

  messaging: {
    normalizeTarget: (target) => {
      const cleaned = target.trim().toLowerCase();
      try {
        return normalizeEthAddress(cleaned);
      } catch {
        return cleaned;
      }
    },
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        return /^0x[0-9a-fA-F]{40}$/.test(trimmed);
      },
      hint: "<0x... Ethereum address>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getXmtpRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`XMTP bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "xmtp",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      await bus.sendText(to, message);
      core.channel.activity.record({
        channel: "xmtp",
        accountId: aid,
        direction: "outbound",
      });
      core.logging
        .getChildLogger?.({ channel: "xmtp", accountId: aid })
        ?.debug?.(
          `xmtp outbound: to=${to} len=${message.length} preview="${previewText(message, 160)}"`,
        );
      return {
        channel: "xmtp" as const,
        to,
        messageId: `xmtp-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("xmtp", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      address: snapshot.address ?? null,
      env: snapshot.env ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      address: account.address,
      env: account.env,
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
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        address: account.address,
        env: account.env,
      });
      ctx.log?.info(
        `[${account.accountId}] starting XMTP provider (address: ${account.address}, env: ${account.env})`,
      );

      if (!account.configured) {
        throw new Error("XMTP walletKey and dbEncryptionKey not configured");
      }

      const runtime = getXmtpRuntime();

      const bus = await startXmtpBus({
        accountId: account.accountId,
        walletKey: account.walletKey,
        dbEncryptionKey: account.dbEncryptionKey,
        env: account.env,
        dbPath: account.config.dbPath,
        onMessage: async ({ senderAddress, senderInboxId, conversationId, text, messageId }) => {
          const cfg = runtime.config.loadConfig() as OpenClawConfig;
          runtime.channel.activity.record({
            channel: "xmtp",
            accountId: account.accountId,
            direction: "inbound",
          });

          const rawBody = text.trim();
          if (!rawBody) {
            return;
          }

          const dmPolicy = account.config.dmPolicy ?? "pairing";
          const configuredAllowFrom = normalizeAllowEntries(account.config.allowFrom ?? []);
          const storeAllowFrom = normalizeAllowEntries(
            await runtime.channel.pairing.readAllowFromStore("xmtp", account.accountId).catch(() => []),
          );
          const effectiveAllowFrom = [...configuredAllowFrom, ...storeAllowFrom];
          const allowMatch = resolveAllowlistMatchSimple({
            allowFrom: effectiveAllowFrom,
            senderId: senderAddress,
          });
          const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);

          if (dmPolicy === "disabled") {
            ctx.log?.debug?.(`[${account.accountId}] blocked xmtp DM ${senderAddress} (disabled)`);
            return;
          }

          if (dmPolicy !== "open" && !allowMatch.allowed) {
            if (dmPolicy === "pairing") {
              try {
                const { code, created } = await runtime.channel.pairing.upsertPairingRequest({
                  channel: "xmtp",
                  id: senderAddress,
                  accountId: account.accountId,
                  meta: {
                    inboxId: senderInboxId,
                  },
                });
                if (created) {
                  ctx.log?.info?.(
                    `[${account.accountId}] xmtp pairing request from ${senderAddress} (${allowMatchMeta})`,
                  );
                  const reply = runtime.channel.pairing.buildPairingReply({
                    channel: "xmtp",
                    idLine: `Your XMTP address: ${senderAddress}`,
                    code,
                  });
                  await bus.sendText(conversationId, reply);
                  runtime.channel.activity.record({
                    channel: "xmtp",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  ctx.log?.debug?.(
                    `[${account.accountId}] xmtp pairing reply to=${conversationId} len=${reply.length}`,
                  );
                }
              } catch (err) {
                ctx.log?.error?.(
                  `[${account.accountId}] xmtp pairing reply failed for ${senderAddress}: ${String(err)}`,
                );
              }
            } else {
              ctx.log?.debug?.(
                `[${account.accountId}] blocked unauthorized xmtp sender ${senderAddress} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
              );
            }
            return;
          }

          const allowTextCommands = runtime.channel.commands.shouldHandleTextCommands({
            cfg,
            surface: "xmtp",
          });
          const hasControlCommand = runtime.channel.commands.isControlCommandMessage(rawBody, cfg);
          const commandGate = resolveControlCommandGate({
            useAccessGroups: cfg.commands?.useAccessGroups !== false,
            authorizers: [
              {
                configured: effectiveAllowFrom.length > 0,
                allowed: allowMatch.allowed,
              },
            ],
            allowTextCommands,
            hasControlCommand,
          });

          if (commandGate.shouldBlock) {
            ctx.log?.debug?.(
              `[${account.accountId}] blocked xmtp control command from ${senderAddress} (${allowMatchMeta})`,
            );
            return;
          }

          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "xmtp",
            accountId: account.accountId,
            peer: { kind: "direct", id: senderAddress },
          });

          const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const body = runtime.channel.reply.formatAgentEnvelope({
            channel: "XMTP",
            from: senderAddress,
            envelope: envelopeOptions,
            body: rawBody,
          });

          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: rawBody,
            RawBody: rawBody,
            CommandBody: rawBody,
            From: `xmtp:${senderAddress}`,
            To: `xmtp:${account.address}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct" as const,
            ConversationLabel: senderAddress,
            SenderName: senderAddress,
            SenderId: senderAddress,
            Provider: "xmtp",
            Surface: "xmtp",
            MessageSid: messageId,
            MessageSidFull: messageId,
            OriginatingChannel: "xmtp",
            OriginatingTo: `xmtp:${account.address}`,
            CommandAuthorized: commandGate.commandAuthorized,
          });

          ctx.log?.debug?.(
            `[${account.accountId}] xmtp inbound: sender=${senderAddress} sid=${messageId} len=${rawBody.length} ${allowMatchMeta} preview="${previewText(rawBody)}"`,
          );

          const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              ctx.log?.error?.(`[${account.accountId}] session record failed: ${String(err)}`);
            },
          });

          const tableMode = runtime.channel.text.resolveMarkdownTableMode({
            cfg,
            channel: "xmtp",
            accountId: account.accountId,
          });

          const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
            cfg,
            agentId: route.agentId,
            channel: "xmtp",
            accountId: account.accountId,
          });

          await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              ...prefixOptions,
              deliver: async (payload: ReplyPayload) => {
                const message = runtime.channel.text.convertMarkdownTables(
                  payload.text ?? "",
                  tableMode,
                );
                if (message) {
                  await bus.sendText(conversationId, message);
                  runtime.channel.activity.record({
                    channel: "xmtp",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  ctx.log?.debug?.(
                    `[${account.accountId}] xmtp outbound: to=${conversationId} len=${message.length} preview="${previewText(message, 160)}"`,
                  );
                }
              },
              onError: (err, info) => {
                ctx.log?.error?.(
                  `[${account.accountId}] xmtp ${info.kind} reply failed: ${String(err)}`,
                );
              },
            },
            replyOptions: {
              onModelSelected,
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] XMTP error (${context}): ${error.message}`);
        },
        onConnect: () => {
          ctx.log?.info?.(`[${account.accountId}] XMTP agent connected (env: ${account.env})`);
        },
      });

      activeBuses.set(account.accountId, bus);

      ctx.log?.info(`[${account.accountId}] XMTP provider started (address: ${bus.getAddress()})`);

      return {
        stop: async () => {
          await bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] XMTP provider stopped`);
        },
      };
    },
  },
};
