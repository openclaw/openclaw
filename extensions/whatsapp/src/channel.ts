import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
// WhatsApp-specific imports from local extension code (moved from src/web/ and src/channels/plugins/)
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";
import { whatsappApprovalAuth } from "./approval-auth.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { looksLikeWhatsAppTargetId, normalizeWhatsAppMessagingTarget } from "./normalize.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import {
  createActionGate,
  createWhatsAppOutboundBase,
  DEFAULT_ACCOUNT_ID,
  formatWhatsAppConfigAllowFromEntries,
  readStringParam,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppOutboundTarget,
  resolveWhatsAppHeartbeatRecipients,
  resolveWhatsAppMentionStripRegexes,
  type ChannelMessageActionName,
  type ChannelPlugin,
  type OpenClawConfig,
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
} from "./runtime-api.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import {
  createWhatsAppPluginBase,
  loadWhatsAppChannelRuntime,
  whatsappSetupWizardProxy,
  WHATSAPP_CHANNEL,
} from "./shared.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

type WhatsAppSendModule = typeof import("./send.js");
type WhatsAppActionRuntimeModule = typeof import("./action-runtime.js");

let whatsAppSendModulePromise: Promise<WhatsAppSendModule> | undefined;
let whatsAppActionRuntimeModulePromise: Promise<WhatsAppActionRuntimeModule> | undefined;

async function loadWhatsAppSendModule() {
  whatsAppSendModulePromise ??= import("./send.js");
  return await whatsAppSendModulePromise;
}

async function loadWhatsAppActionRuntimeModule() {
  whatsAppActionRuntimeModulePromise ??= import("./action-runtime.js");
  return await whatsAppActionRuntimeModulePromise;
}

function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

function parseWhatsAppExplicitTarget(raw: string) {
  const normalized = normalizeWhatsAppTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    to: normalized,
    chatType: isWhatsAppGroupJid(normalized) ? ("group" as const) : ("direct" as const),
  };
}

function areWhatsAppAgentReactionsEnabled(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return false;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return false;
  }
  return resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  }).agentReactionsEnabled;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return areWhatsAppAgentReactionsEnabled({
      cfg,
      accountId,
    });
  });
}

function resolveWhatsAppAgentReactionGuidance(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!resolved.agentReactionsEnabled) {
    return undefined;
  }
  return resolved.agentReactionGuidance;
}

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> =
  createChatChannelPlugin<ResolvedWhatsAppAccount>({
    pairing: {
      idLabel: "whatsappSenderId",
    },
    outbound: {
      ...createWhatsAppOutboundBase({
        chunker: chunkText,
        sendMessageWhatsApp: async (...args) =>
          await (await loadWhatsAppSendModule()).sendMessageWhatsApp(...args),
        sendPollWhatsApp: async (...args) =>
          await (await loadWhatsAppSendModule()).sendPollWhatsApp(...args),
        shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
        resolveTarget: ({ to, allowFrom, mode }) =>
          resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
      }),
      normalizePayload: ({ payload }) => ({
        ...payload,
        text: normalizeWhatsAppPayloadText(payload.text),
      }),
    },
    base: {
      ...createWhatsAppPluginBase({
        groups: {
          resolveRequireMention: resolveWhatsAppGroupRequireMention,
          resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
          resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
        },
        setupWizard: whatsappSetupWizardProxy,
        setup: whatsappSetupAdapter,
        isConfigured: async (account) =>
          await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir),
      }),
      agentTools: () => [createWhatsAppLoginTool()],
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "whatsapp",
        resolveAccount: resolveWhatsAppAccount,
        normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
        resolveDmAllowFrom: (account) => account.allowFrom,
        resolveGroupAllowFrom: (account) => account.groupAllowFrom,
        resolveDmPolicy: (account) => account.dmPolicy,
        resolveGroupPolicy: (account) => account.groupPolicy,
      }),
      mentions: {
        stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx),
      },
      commands: {
        enforceOwnerForCommands: true,
        skipWhenConfigEmpty: true,
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
        normalizeTarget: normalizeWhatsAppMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveWhatsAppOutboundSessionRoute(params),
        parseExplicitTarget: ({ raw }) => parseWhatsAppExplicitTarget(raw),
        inferTargetChatType: ({ to }) => parseWhatsAppExplicitTarget(to)?.chatType,
        targetResolver: {
          looksLikeId: looksLikeWhatsAppTargetId,
          hint: "<E.164|group JID>",
        },
      },
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
        listPeers: async (params) => listWhatsAppDirectoryPeersFromConfig(params),
        listGroups: async (params) => listWhatsAppDirectoryGroupsFromConfig(params),
      },
      actions: {
        describeMessageTool: ({ cfg, accountId }) => {
          if (!cfg.channels?.whatsapp) {
            return null;
          }
          const gate = createActionGate(cfg.channels.whatsapp.actions);
          const actions = new Set<ChannelMessageActionName>();
          const canReact =
            accountId != null
              ? areWhatsAppAgentReactionsEnabled({
                  cfg,
                  accountId: accountId ?? undefined,
                })
              : hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg);
          if (canReact) {
            actions.add("react");
          }
          if (gate("polls")) {
            actions.add("poll");
          }
          return { actions: Array.from(actions) };
        },
        supportsAction: ({ action }) => action === "react",
        handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
          if (action !== "react") {
            throw new Error(`Action ${action} is not supported for provider ${WHATSAPP_CHANNEL}.`);
          }
          // Only fall back to the inbound message id when the current turn
          // originates from WhatsApp and targets the same chat. Skip the
          // fallback when the source is another provider (the message id
          // would be meaningless) or when the caller routes to a different
          // WhatsApp chat (the id would belong to the wrong conversation).
          const isWhatsAppSource = toolContext?.currentChannelProvider === WHATSAPP_CHANNEL;
          const explicitTarget =
            readStringParam(params, "chatJid") ?? readStringParam(params, "to");
          const normalizedTarget = explicitTarget ? normalizeWhatsAppTarget(explicitTarget) : null;
          const normalizedCurrent =
            isWhatsAppSource && toolContext?.currentChannelId
              ? normalizeWhatsAppTarget(toolContext.currentChannelId)
              : null;
          // When an explicit target is provided, require a known current chat
          // to compare against. If currentChannelId is missing/unparseable,
          // treat it as ineligible for fallback to avoid cross-chat leaks.
          const isCrossChat =
            normalizedTarget != null &&
            (normalizedCurrent == null || normalizedTarget !== normalizedCurrent);
          const scopedContext = !isWhatsAppSource || isCrossChat ? undefined : toolContext;
          const messageIdRaw = resolveReactionMessageId({
            args: params,
            toolContext: scopedContext,
          });
          if (messageIdRaw == null) {
            // Delegate to readStringParam so the gateway maps the error to 400.
            readStringParam(params, "messageId", { required: true });
          }
          const messageId = String(messageIdRaw);
          const emoji = readStringParam(params, "emoji", { allowEmpty: true });
          const remove = typeof params.remove === "boolean" ? params.remove : undefined;
          return await (
            await loadWhatsAppActionRuntimeModule()
          ).handleWhatsAppAction(
            {
              action: "react",
              chatJid:
                readStringParam(params, "chatJid") ??
                readStringParam(params, "to", { required: true }),
              messageId,
              emoji,
              remove,
              participant: readStringParam(params, "participant"),
              accountId: accountId ?? undefined,
              fromMe: typeof params.fromMe === "boolean" ? params.fromMe : undefined,
            },
            cfg,
          );
        },
      },
      auth: {
        ...whatsappApprovalAuth,
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
          if (cfg.web?.enabled === false) {
            return { ok: false, reason: "whatsapp-disabled" };
          }
          const account = resolveWhatsAppAccount({ cfg, accountId });
          const authExists = await (
            deps?.webAuthExists ?? (await loadWhatsAppChannelRuntime()).webAuthExists
          )(account.authDir);
          if (!authExists) {
            return { ok: false, reason: "whatsapp-not-linked" };
          }
          const listenerActive = deps?.hasActiveWebListener
            ? deps.hasActiveWebListener()
            : Boolean((await loadWhatsAppChannelRuntime()).getActiveWebListener());
          if (!listenerActive) {
            return { ok: false, reason: "whatsapp-not-running" };
          }
          return { ok: true, reason: "ok" };
        },
        resolveRecipients: ({ cfg, opts }) => resolveWhatsAppHeartbeatRecipients(cfg, opts),
      },
      status: createAsyncComputedAccountStatusAdapter<ResolvedWhatsAppAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastInboundAt: null,
          lastMessageAt: null,
          lastEventAt: null,
          healthState: "stopped",
        }),
        collectStatusIssues: collectWhatsAppStatusIssues,
        buildChannelSummary: async ({ account, snapshot }) => {
          const authDir = account.authDir;
          const linked =
            typeof snapshot.linked === "boolean"
              ? snapshot.linked
              : authDir
                ? await (await loadWhatsAppChannelRuntime()).webAuthExists(authDir)
                : false;
          const authAgeMs =
            linked && authDir
              ? (await loadWhatsAppChannelRuntime()).getWebAuthAgeMs(authDir)
              : null;
          const self =
            linked && authDir
              ? (await loadWhatsAppChannelRuntime()).readWebSelfId(authDir)
              : { e164: null, jid: null };
          return {
            configured: linked,
            linked,
            authAgeMs,
            self,
            running: snapshot.running ?? false,
            connected: snapshot.connected ?? false,
            lastConnectedAt: snapshot.lastConnectedAt ?? null,
            lastDisconnect: snapshot.lastDisconnect ?? null,
            reconnectAttempts: snapshot.reconnectAttempts,
            lastInboundAt: snapshot.lastInboundAt ?? snapshot.lastMessageAt ?? null,
            lastMessageAt: snapshot.lastMessageAt ?? null,
            lastEventAt: snapshot.lastEventAt ?? null,
            lastError: snapshot.lastError ?? null,
            healthState: snapshot.healthState ?? undefined,
          };
        },
        resolveAccountSnapshot: async ({ account, runtime }) => {
          const linked = await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir);
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: true,
            extra: {
              linked,
              connected: runtime?.connected ?? false,
              reconnectAttempts: runtime?.reconnectAttempts,
              lastConnectedAt: runtime?.lastConnectedAt ?? null,
              lastDisconnect: runtime?.lastDisconnect ?? null,
              lastInboundAt: runtime?.lastInboundAt ?? runtime?.lastMessageAt ?? null,
              lastMessageAt: runtime?.lastMessageAt ?? null,
              lastEventAt: runtime?.lastEventAt ?? null,
              healthState: runtime?.healthState ?? undefined,
              dmPolicy: account.dmPolicy,
              allowFrom: account.allowFrom,
            },
          };
        },
        resolveAccountState: ({ configured }) => (configured ? "linked" : "not linked"),
        logSelfId: ({ account, runtime, includeChannelPrefix }) => {
          void loadWhatsAppChannelRuntime().then((runtimeExports) =>
            runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix),
          );
        },
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
          const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
          ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
          return (await loadWhatsAppChannelRuntime()).monitorWebChannel(
            getWhatsAppRuntime().logging.shouldLogVerbose(),
            undefined,
            true,
            undefined,
            ctx.runtime,
            ctx.abortSignal,
            {
              statusSink: (next: WebChannelStatus) =>
                ctx.setStatus({ accountId: ctx.accountId, ...next }),
              accountId: account.accountId,
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
        loginWithQrWait: async ({ accountId, timeoutMs }) =>
          await (await loadWhatsAppChannelRuntime()).waitForWebLogin({ accountId, timeoutMs }),
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
