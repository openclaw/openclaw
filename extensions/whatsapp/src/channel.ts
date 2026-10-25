import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelAccountSnapshot,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import { whatsappApprovalCapability } from "./approval-native.js";
import { readWebAuthExistsForDecision, WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import { whatsappChannelOutbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { loadWhatsAppChannelRuntime } from "./channel-runtime-loader.js";
import { whatsappCommandPolicy } from "./command-policy.js";
import { resolveWhatsAppMentionStripRegexes } from "./group-intro.js";
import { resolveWhatsAppGroupSessionKey } from "./group-session-key.js";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntry,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendTypingWhatsApp } from "./send.js";
import { createWhatsAppPluginBase } from "./shared.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const loadWhatsAppDirectoryConfig = createLazyRuntimeModule(() => import("./directory-config.js"));
const loadWhatsAppChannelReactAction = createLazyRuntimeModule(
  () => import("./channel-react-action.js"),
);

function resolveEnabledWhatsAppAgentReactions(cfg: OpenClawConfig, accountId?: string) {
  if (!cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({ cfg, accountId });
  return resolved.agentReactionsEnabled ? resolved : undefined;
}

function projectWhatsAppRuntimeStatus(runtime?: ChannelAccountSnapshot) {
  return {
    connected: runtime?.connected ?? false,
    reconnectAttempts: runtime?.reconnectAttempts,
    lastConnectedAt: runtime?.lastConnectedAt ?? null,
    lastDisconnect: runtime?.lastDisconnect ?? null,
    lastInboundAt: runtime?.lastInboundAt ?? runtime?.lastMessageAt ?? null,
    lastMessageAt: runtime?.lastMessageAt ?? null,
    lastEventAt: runtime?.lastEventAt ?? null,
    busy: runtime?.busy ?? false,
    lastRunActivityAt: runtime?.lastRunActivityAt ?? null,
    healthState: runtime?.healthState,
    ...(runtime?.terminalDisconnect ? { terminalDisconnect: runtime.terminalDisconnect } : {}),
  };
}

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> =
  createChatChannelPlugin<ResolvedWhatsAppAccount>({
    pairing: {
      idLabel: "whatsappSenderId",
      normalizeAllowEntry: (entry) => normalizeWhatsAppAllowFromEntry(entry) ?? "",
    },
    outbound: whatsappChannelOutbound,
    threading: {
      scopedAccountReplyToMode: {
        resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
        resolveReplyToMode: (account) => account.replyToMode,
      },
    },
    base: {
      ...createWhatsAppPluginBase(),
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "whatsapp",
        resolveAccount: resolveWhatsAppAccount,
        normalize: ({ values }) => normalizeWhatsAppAllowFromEntries(values),
        resolveDmAllowFrom: (account) => account.allowFrom,
        resolveGroupAllowFrom: (account) => account.groupAllowFrom,
        resolveDmPolicy: (account) => account.dmPolicy,
        resolveGroupPolicy: (account) => account.groupPolicy,
      }),
      mentions: {
        stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx),
      },
      commands: whatsappCommandPolicy,
      bindings: {
        compileConfiguredBinding: ({ conversationId }) => {
          const normalized = normalizeWhatsAppTarget(conversationId);
          return normalized ? { conversationId: normalized } : null;
        },
        matchInboundConversation: ({ compiledBinding, conversationId }) => {
          const normalizedConversationId = normalizeWhatsAppTarget(conversationId);
          if (normalizedConversationId === compiledBinding.conversationId) {
            return { conversationId: compiledBinding.conversationId, matchPriority: 2 };
          }
          return null;
        },
      },
      agentPrompt: {
        reactionGuidance: ({ cfg, accountId }) => {
          const level = resolveEnabledWhatsAppAgentReactions(
            cfg,
            accountId ?? undefined,
          )?.agentReactionGuidance;
          return level ? { level, channelLabel: "WhatsApp" } : undefined;
        },
      },
      messaging: {
        targetPrefixes: ["whatsapp"],
        normalizeTarget: normalizeWhatsAppMessagingTarget,
        resolveOutboundSessionRoute: (params) => {
          const normalized = normalizeWhatsAppTarget(params.target);
          if (!normalized) {
            return null;
          }
          const isGroup = normalized.endsWith("@g.us");
          const isNewsletter = normalized.endsWith("@newsletter");
          const chatType = isGroup ? "group" : isNewsletter ? "channel" : "direct";
          const route = buildChannelOutboundSessionRoute({
            cfg: params.cfg,
            agentId: params.agentId,
            channel: "whatsapp",
            accountId: params.accountId,
            recipientSessionExact: true,
            peer: {
              kind: chatType,
              id: normalized,
            },
            chatType,
            from: normalized,
            to: normalized,
          });
          return isGroup
            ? {
                ...route,
                sessionKey: resolveWhatsAppGroupSessionKey({
                  sessionKey: route.sessionKey,
                  accountId: params.accountId,
                }),
              }
            : route;
        },
        inferTargetChatType: ({ to }) => {
          const normalized = normalizeWhatsAppTarget(to);
          return !normalized
            ? undefined
            : isWhatsAppGroupJid(normalized)
              ? "group"
              : isWhatsAppNewsletterJid(normalized)
                ? "channel"
                : "direct";
        },
        targetResolver: {
          looksLikeId: looksLikeWhatsAppTargetId,
          hint: "<E.164|group JID|newsletter JID>",
        },
      },
      message: whatsappMessageAdapter,
      directory: {
        self: async ({ cfg, accountId }) => {
          const account = resolveWhatsAppAccount({ cfg, accountId });
          const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
          const id = e164 ?? jid;
          if (!id) {
            return null;
          }
          return {
            kind: "user",
            id,
            name: account.name,
            raw: { e164, jid },
          };
        },
        listPeers: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryPeersFromConfig(params),
        listGroups: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryGroupsFromConfig(params),
        listGroupsLive: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryGroupsLive(params),
      },
      actions: {
        messageActionTargetAliases: {
          react: {
            aliases: ["chatJid", "messageId"],
            deliveryTargetAliases: ["chatJid"],
            resolveDeliveryTarget: ({ args }) => {
              const chatJid = args.chatJid;
              return typeof chatJid === "string"
                ? normalizeWhatsAppMessagingTarget(chatJid)
                : undefined;
            },
          },
        },
        describeMessageTool: ({ cfg, accountId }) => {
          if (!cfg.channels?.whatsapp) {
            return null;
          }
          const gate = createActionGate(cfg.channels.whatsapp.actions);
          const actions: ChannelMessageActionName[] = [];
          const canReact =
            accountId != null
              ? Boolean(resolveEnabledWhatsAppAgentReactions(cfg, accountId))
              : listWhatsAppAccountIds(cfg).some((listedAccountId) => {
                  const account = resolveWhatsAppAccount({ cfg, accountId: listedAccountId });
                  return (
                    account.enabled &&
                    Boolean(resolveEnabledWhatsAppAgentReactions(cfg, listedAccountId))
                  );
                });
          if (canReact) {
            actions.push("react");
          }
          if (gate("polls")) {
            actions.push("poll");
          }
          actions.push("upload-file");
          return { actions };
        },
        supportsAction: ({ action }) => action === "react" || action === "upload-file",
        resolveExecutionMode: ({ action }) =>
          action === "react" || action === "upload-file" ? "gateway" : "local",
        handleAction: async (params) =>
          await (await loadWhatsAppChannelReactAction()).handleWhatsAppMessageAction(params),
      },
      approvalCapability: whatsappApprovalCapability,
      auth: {
        login: async ({ cfg, accountId, runtime, verbose }) => {
          const resolvedAccountId =
            accountId?.trim() ||
            whatsappPlugin.config.defaultAccountId?.(cfg) ||
            DEFAULT_ACCOUNT_ID;
          await (
            await loadWhatsAppChannelRuntime()
          ).loginWeb(Boolean(verbose), undefined, runtime, resolvedAccountId);
        },
      },
      heartbeat: {
        checkReady: async ({ cfg, accountId, deps }) => {
          if (cfg.channels?.whatsapp?.enabled === false) {
            return { ok: false as const, reason: "whatsapp-disabled" as const };
          }
          const account = resolveWhatsAppAccount({ cfg, accountId: accountId ?? undefined });
          const authState = await readWebAuthExistsForDecision(account.authDir);
          if (authState.outcome === "unstable") {
            return { ok: false as const, reason: WHATSAPP_AUTH_UNSTABLE_CODE };
          }
          if (!authState.exists) {
            return { ok: false as const, reason: "whatsapp-not-linked" as const };
          }
          const listenerActive = deps?.hasActiveWebListener
            ? deps.hasActiveWebListener(account.accountId)
            : Boolean((await loadWhatsAppChannelRuntime()).getActiveWebListener(account.accountId));
          if (!listenerActive) {
            return { ok: false as const, reason: "whatsapp-not-running" as const };
          }
          return { ok: true as const, reason: "ok" as const };
        },
        sendTyping: async ({ cfg, to, accountId }) => {
          await sendTypingWhatsApp(to, {
            cfg,
            ...(accountId ? { accountId } : {}),
          });
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedWhatsAppAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastInboundAt: null,
          lastMessageAt: null,
          lastEventAt: null,
          busy: false,
          lastRunActivityAt: null,
          healthState: "stopped",
          lifecycle: "stopped" as const,
        }),
        collectStatusIssues: collectWhatsAppStatusIssues,
        buildChannelSummary: async ({ account, snapshot }) => {
          const channelRuntime = await loadWhatsAppChannelRuntime();
          const authDir = account.authDir;
          const auth = authDir
            ? await channelRuntime.readWebAuthSnapshot(authDir)
            : {
                state: "not-linked" as const,
                authAgeMs: null,
                selfId: { e164: null, jid: null, lid: null },
              };
          const linked =
            snapshot.healthState === "logged-out"
              ? false
              : typeof snapshot.linked === "boolean"
                ? snapshot.linked
                : auth.state === "unstable"
                  ? undefined
                  : auth.state === "linked";
          const statusState =
            auth.state === "unstable"
              ? auth.state
              : linked === true
                ? "linked"
                : linked === false
                  ? "not-linked"
                  : undefined;
          return {
            configured: Boolean(account.authDir),
            ...(statusState ? { statusState } : {}),
            ...(typeof linked === "boolean" ? { linked } : {}),
            authAgeMs: linked ? auth.authAgeMs : null,
            self: linked ? auth.selfId : { e164: null, jid: null, lid: null },
            running: snapshot.running ?? false,
            ...projectWhatsAppRuntimeStatus(snapshot),
            lastError: snapshot.lastError ?? null,
            lifecycle: snapshot.lifecycle ?? undefined,
          };
        },
        resolveAccountSnapshot: ({ account, runtime }) => {
          const locallyRevoked = runtime?.healthState === "logged-out";
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: Boolean(account.authDir),
            extra: {
              ...(locallyRevoked ? { statusState: "not-linked", linked: false } : {}),
              ...projectWhatsAppRuntimeStatus(runtime),
              dmPolicy: account.dmPolicy,
              allowFrom: account.allowFrom,
            },
          };
        },
        logSelfId: ({ account, runtime, includeChannelPrefix }) => {
          void loadWhatsAppChannelRuntime().then((runtimeExports) =>
            runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix),
          );
        },
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const channelRuntime = await loadWhatsAppChannelRuntime();
          const auth = await channelRuntime.readWebAuthSnapshot(account.authDir);
          ctx.abortSignal.throwIfAborted();
          const { e164, jid } = auth.selfId;
          const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
          ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
          return channelRuntime.monitorWebChannel(
            getWhatsAppRuntime().logging.shouldLogVerbose(),
            undefined,
            true,
            undefined,
            ctx.runtime,
            ctx.abortSignal,
            {
              statusSink: (next: WebChannelStatus) => {
                const hasIdentity = next.running && next.healthState !== "logged-out";
                const snapshot = {
                  accountId: ctx.accountId,
                  ...next,
                  self: hasIdentity ? auth.selfId : null,
                  authAgeMs: hasIdentity
                    ? next.authAgeMs === undefined
                      ? auth.authAgeMs
                      : next.authAgeMs
                    : null,
                  ...(next.healthState === "logged-out" ? { linked: false } : {}),
                };
                ctx.setStatus(snapshot);
              },
              accountId: account.accountId,
              channelRuntime: ctx.channelRuntime,
            },
          );
        },
        loginWithQrStart: async (params) =>
          await (await loadWhatsAppChannelRuntime()).startWebLoginWithQr(params),
        loginWithQrWait: async ({ accountId, timeoutMs, currentQrDataUrl }) =>
          await (
            await loadWhatsAppChannelRuntime()
          ).waitForWebLogin({ accountId, timeoutMs, currentQrDataUrl }),
        logoutAccount: async ({ account, runtime }) => {
          const cleared = await (
            await loadWhatsAppChannelRuntime()
          ).logoutWeb({
            authDir: account.authDir,
            isLegacyAuthDir: account.isLegacyAuthDir,
            runtime,
          });
          return { cleared, loggedOut: cleared };
        },
      },
    },
  });
