import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveWhatsAppAccount, type ResolvedWhatsAppAccount } from "./accounts.js";
import { whatsappApprovalCapability } from "./approval-native.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import {
  describeWhatsAppMessageActions,
  resolveWhatsAppAgentReactionGuidance,
} from "./channel-actions.js";
import { whatsappChannelOutbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { loadWhatsAppChannelRuntime } from "./channel-runtime-loader.js";
import { whatsappCommandPolicy } from "./command-policy.js";
import { resolveWhatsAppMentionStripRegexes } from "./group-intro.js";
import { checkWhatsAppHeartbeatReady } from "./heartbeat.js";
import type { WhatsAppSelfIdentity } from "./identity.js";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntry,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendTypingWhatsApp } from "./send.js";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";
import { createWhatsAppPluginBase } from "./shared.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const loadWhatsAppDirectoryConfig = createLazyRuntimeModule(() => import("./directory-config.js"));
const loadWhatsAppChannelReactAction = createLazyRuntimeModule(
  () => import("./channel-react-action.js"),
);

type WhatsAppStatusSnapshot = ChannelAccountSnapshot & {
  self: WhatsAppSelfIdentity | null;
  authAgeMs: number | null;
};

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
    healthState: runtime?.healthState ?? undefined,
    ...(runtime?.terminalDisconnect ? { terminalDisconnect: runtime.terminalDisconnect } : {}),
  };
}

function resolveWhatsAppMessageActionTarget(params: { args: Record<string, unknown> }) {
  const chatJid = params.args.chatJid;
  return typeof chatJid === "string" ? normalizeWhatsAppMessagingTarget(chatJid) : undefined;
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
          const level = resolveWhatsAppAgentReactionGuidance({
            cfg,
            accountId: accountId ?? undefined,
          });
          return level ? { level, channelLabel: "WhatsApp" } : undefined;
        },
      },
      messaging: {
        targetPrefixes: ["whatsapp"],
        normalizeTarget: normalizeWhatsAppMessagingTarget,
        resolveOutboundSessionRoute: resolveWhatsAppOutboundSessionRoute,
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
            resolveDeliveryTarget: resolveWhatsAppMessageActionTarget,
          },
        },
        describeMessageTool: ({ cfg, accountId }) =>
          describeWhatsAppMessageActions({ cfg, accountId }),
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
        checkReady: async ({ cfg, accountId, deps }) =>
          await checkWhatsAppHeartbeatReady({ cfg, accountId: accountId ?? undefined, deps }),
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
                const snapshot: WhatsAppStatusSnapshot = {
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
        loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) =>
          await (
            await loadWhatsAppChannelRuntime()
          ).startWebLoginWithQr({
            accountId,
            force,
            timeoutMs,
            verbose,
          }),
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
