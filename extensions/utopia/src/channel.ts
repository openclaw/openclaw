import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/irc";
import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/signal-core";
import { UtopiaConfigSchema } from "./config-schema.js";
import { getUtopiaRuntime } from "./runtime.js";
import {
  listUtopiaAccountIds,
  resolveDefaultUtopiaAccountId,
  resolveUtopiaAccount,
  type ResolvedUtopiaAccount,
} from "./types.js";
import type { UtopiaApiConfig } from "./utopia-api.js";
import { getSystemInfo } from "./utopia-api.js";
import { startUtopiaBus, type UtopiaBusHandle } from "./utopia-bus.js";

// Store active bus handles per account
const activeBuses = new Map<string, UtopiaBusHandle>();

export const utopiaPlugin: ChannelPlugin<ResolvedUtopiaAccount> = {
  id: "utopia",
  meta: {
    id: "utopia",
    label: "Utopia",
    selectionLabel: "Utopia",
    docsPath: "/channels/utopia",
    docsLabel: "utopia",
    blurb: "Decentralized messenger with crypto support; direct messages via Utopia API.",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.utopia"] },
  configSchema: buildChannelConfigSchema(UtopiaConfigSchema),

  config: {
    listAccountIds: (cfg) => listUtopiaAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveUtopiaAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultUtopiaAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveUtopiaAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },

  pairing: {
    idLabel: "utopiaPubkey",
    normalizeAllowEntry: (entry) => entry.replace(/^utopia:/i, "").trim(),
    notifyApproval: ({ accountId, id }) => {
      const bus = activeBuses.get(accountId);
      if (!bus) {
        // Intentionally drop: account not connected for this gateway
        return;
      }
      void bus.sendApprovalDm(id);
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.utopia.dmPolicy",
        allowFromPath: "channels.utopia.allowFrom",
        approveHint: formatPairingApproveHint("utopia"),
        normalizeEntry: (raw) => raw.replace(/^utopia:/i, "").trim(),
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => target.replace(/^utopia:/i, "").trim(),
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        // Utopia public keys are 64 hex characters
        return /^[0-9a-fA-F]{64}$/.test(trimmed);
      },
      hint: "<utopia pubkey>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunkerMode: "markdown" as const,
    chunker: (text: string, limit: number) =>
      getUtopiaRuntime().channel.text.chunkMarkdownText(text, limit),
    sendText: async ({ cfg, to, text, accountId }) => {
      const core = getUtopiaRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Utopia bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "utopia",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      await bus.sendDm(to, message);
      return {
        channel: "utopia" as const,
        to,
        messageId: `utopia-${crypto.randomUUID()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("utopia", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      publicKey: snapshot.publicKey ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!account.configured) {
        return { ok: false, error: "Not configured" };
      }
      const apiConfig: UtopiaApiConfig = {
        host: account.host,
        port: account.port,
        token: account.apiToken,
        useSsl: account.useSsl,
      };
      try {
        const info = await getSystemInfo(apiConfig);
        return { ok: true, info };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
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
      ctx.setStatus({ accountId: account.accountId });
      ctx.log?.info(`[${account.accountId}] starting Utopia provider`);

      if (!account.configured) {
        throw new Error("Utopia API token not configured");
      }

      const apiConfig: UtopiaApiConfig = {
        host: account.host,
        port: account.port,
        token: account.apiToken,
        useSsl: account.useSsl,
      };

      const bus = await startUtopiaBus({
        apiConfig,
        wsPort: account.wsPort,
        accountId: account.accountId,
        onMessage: async (senderPubkey, senderNick, text, reply) => {
          ctx.log?.info?.(
            `[${account.accountId}] DM from ${senderPubkey}: ${text.slice(0, 50)}...`,
          );

          if (!ctx.channelRuntime) {
            ctx.log?.warn?.(`[${account.accountId}] channelRuntime not available`);
            return;
          }

          const route = ctx.channelRuntime.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            channel: "utopia",
            accountId: account.accountId,
            peer: { kind: "direct", id: senderPubkey },
          });

          const storePath = ctx.channelRuntime.session.resolveStorePath(undefined, {
            agentId: route.agentId,
          });

          const ctxPayload = ctx.channelRuntime.reply.finalizeInboundContext({
            Body: text,
            From: senderPubkey,
            SenderName: senderNick,
            AccountId: account.accountId,
            Provider: "utopia",
            ChatType: "direct",
            SessionKey: route.sessionKey,
          });

          await dispatchInboundReplyWithBase({
            cfg: ctx.cfg,
            channel: "utopia",
            accountId: account.accountId,
            route,
            storePath,
            ctxPayload,
            core: {
              channel: {
                session: {
                  recordInboundSession: ctx.channelRuntime.session.recordInboundSession,
                },
                reply: {
                  dispatchReplyWithBufferedBlockDispatcher:
                    ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
                },
              },
            },
            deliver: async (payload) => {
              if (payload.text) {
                await reply(payload.text);
              }
            },
            onRecordError: (err) =>
              ctx.log?.warn?.(
                `[${account.accountId}] session record error: ${(err as Error).message}`,
              ),
            onDispatchError: (err, info) =>
              ctx.log?.error?.(
                `[${account.accountId}] dispatch error (${info.kind}): ${(err as Error).message}`,
              ),
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] Utopia error (${context}): ${error.message}`);
        },
        onConnect: () => {
          ctx.log?.info?.(`[${account.accountId}] WebSocket connected`);
        },
        onDisconnect: () => {
          ctx.log?.warn?.(`[${account.accountId}] WebSocket disconnected, will reconnect`);
        },
      });

      // Update account with resolved public key
      account.publicKey = bus.publicKey;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: bus.publicKey,
      });

      activeBuses.set(account.accountId, bus);

      ctx.log?.info(
        `[${account.accountId}] Utopia provider started (pubkey: ${bus.publicKey}, nick: ${bus.nick})`,
      );

      // Stay pending until the abort signal fires (gateway stops the channel)
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      bus.close();
      activeBuses.delete(account.accountId);
      ctx.log?.info(`[${account.accountId}] Utopia provider stopped`);
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg };
      const nextUtopia = cfg.channels?.utopia
        ? { ...(cfg.channels.utopia as Record<string, unknown>) }
        : undefined;
      let cleared = false;

      if (nextUtopia?.apiToken) {
        delete nextUtopia.apiToken;
        cleared = true;
        nextCfg.channels = { ...nextCfg.channels, utopia: nextUtopia };
        await getUtopiaRuntime().config.writeConfigFile(nextCfg);
      }

      const loggedOut = !resolveUtopiaAccount({ cfg: cleared ? nextCfg : cfg, accountId })
        .configured;
      return { cleared, loggedOut };
    },
  },
};
