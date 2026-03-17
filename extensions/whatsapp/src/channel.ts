import { buildAccountScopedAllowlistConfigEditor } from "openclaw/plugin-sdk/allowlist-config-edit";
import {
  buildAccountScopedDmSecurityPolicy,
  buildChannelConfigSchema,
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  createActionGate,
  createWhatsAppOutboundBase,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
  normalizeE164,
  formatWhatsAppConfigAllowFromEntries,
  readStringParam,
  resolveWhatsAppOutboundTarget,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppGroupToolPolicy,
  resolveWhatsAppHeartbeatRecipients,
  resolveWhatsAppMentionStripRegexes,
  WhatsAppConfigSchema,
  type ChannelMessageActionName,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/whatsapp";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "openclaw/plugin-sdk/whatsapp";
// WhatsApp-specific imports from local extension code (moved from src/web/ and src/channels/plugins/)
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "./accounts.js";
import { looksLikeWhatsAppTargetId, normalizeWhatsAppMessagingTarget } from "./normalize.js";
import { loadWhatsAppChannelRuntime, whatsappSetupWizardProxy } from "./plugin-shared.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const meta = getChatChannelMeta("whatsapp");

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

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  id: "whatsapp",
  meta: {
    ...meta,
    showConfigured: false,
    quickstartAllowFrom: true,
    forceAccountBinding: true,
    preferSessionLookupForAnnounceTarget: true,
  },
  setupWizard: whatsappSetupWizardProxy,
  agentTools: () => [getWhatsAppRuntime().channel.whatsapp.createLoginTool()],
  pairing: {
    idLabel: "whatsappSenderId",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: true,
    reactions: true,
    media: true,
  },
  reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  gatewayMethods: ["web.login.start", "web.login.wait"],
  configSchema: buildChannelConfigSchema(WhatsAppConfigSchema),
  config: {
    listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.whatsapp?.accounts };
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          whatsapp: {
            ...cfg.channels?.whatsapp,
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.whatsapp?.accounts };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          whatsapp: {
            ...cfg.channels?.whatsapp,
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      };
    },
    isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
    disabledReason: () => "disabled",
    isConfigured: async (account) =>
      await getWhatsAppRuntime().channel.whatsapp.webAuthExists(account.authDir),
    unconfiguredReason: () => "not linked",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authDir),
      linked: Boolean(account.authDir),
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveWhatsAppConfigAllowFrom({ cfg, accountId }),
    formatAllowFrom: ({ allowFrom }) => formatWhatsAppConfigAllowFromEntries(allowFrom),
    resolveDefaultTo: ({ cfg, accountId }) => resolveWhatsAppConfigDefaultTo({ cfg, accountId }),
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    readConfig: ({ cfg, accountId }) => {
      const account = resolveWhatsAppAccount({ cfg, accountId });
      return {
        dmAllowFrom: (account.allowFrom ?? []).map(String),
        groupAllowFrom: (account.groupAllowFrom ?? []).map(String),
        dmPolicy: account.dmPolicy,
        groupPolicy: account.groupPolicy,
      };
    },
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: "whatsapp",
      normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
      resolvePaths: (scope) => ({
        readPaths: [[scope === "dm" ? "allowFrom" : "groupAllowFrom"]],
        writePath: [scope === "dm" ? "allowFrom" : "groupAllowFrom"],
      }),
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "whatsapp",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.dmPolicy,
        allowFrom: account.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => normalizeE164(raw),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      const groupAllowlistConfigured =
        Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0;
      return collectAllowlistProviderGroupPolicyWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.whatsapp !== undefined,
        configuredGroupPolicy: account.groupPolicy,
        collect: (groupPolicy) =>
          collectOpenGroupPolicyRouteAllowlistWarnings({
            groupPolicy,
            routeAllowlistConfigured: groupAllowlistConfigured,
            restrictSenders: {
              surface: "WhatsApp groups",
              openScope: "any member in allowed groups",
              groupPolicyPath: "channels.whatsapp.groupPolicy",
              groupAllowFromPath: "channels.whatsapp.groupAllowFrom",
            },
            noRouteAllowlist: {
              surface: "WhatsApp groups",
              routeAllowlistPath: "channels.whatsapp.groups",
              routeScope: "group",
              groupPolicyPath: "channels.whatsapp.groupPolicy",
              groupAllowFromPath: "channels.whatsapp.groupAllowFrom",
            },
          }),
      });
    },
  },
  setup: whatsappSetupAdapter,
  groups: {
    resolveRequireMention: resolveWhatsAppGroupRequireMention,
    resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
    resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
  },
  mentions: {
    stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx),
  },
  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },
  messaging: {
    normalizeTarget: normalizeWhatsAppMessagingTarget,
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
    listActions: ({ cfg }) => {
      if (!cfg.channels?.whatsapp) {
        return [];
      }
      const gate = createActionGate(cfg.channels.whatsapp.actions);
      const actions = new Set<ChannelMessageActionName>();
      if (gate("reactions")) {
        actions.add("react");
      }
      if (gate("polls")) {
        actions.add("poll");
      }
      return Array.from(actions);
    },
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action !== "react") {
        throw new Error(`Action ${action} is not supported for provider ${meta.id}.`);
      }
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
        {
          action: "react",
          chatJid:
            readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true }),
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
  outbound: {
    ...createWhatsAppOutboundBase({
      chunker: (text, limit) => getWhatsAppRuntime().channel.text.chunkText(text, limit),
      sendMessageWhatsApp: async (...args) =>
        await getWhatsAppRuntime().channel.whatsapp.sendMessageWhatsApp(...args),
      sendPollWhatsApp: async (...args) =>
        await getWhatsAppRuntime().channel.whatsapp.sendPollWhatsApp(...args),
      shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
      resolveTarget: ({ to, allowFrom, mode }) =>
        resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
    }),
    normalizePayload: ({ payload }) => ({
      ...payload,
      text: normalizeWhatsAppPayloadText(payload.text),
    }),
  },
  auth: {
    login: async ({ cfg, accountId, runtime, verbose }) => {
      const resolvedAccountId = accountId?.trim() || resolveDefaultWhatsAppAccountId(cfg);
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
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    },
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
        linked && authDir ? (await loadWhatsAppChannelRuntime()).getWebAuthAgeMs(authDir) : null;
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
        lastMessageAt: snapshot.lastMessageAt ?? null,
        lastEventAt: snapshot.lastEventAt ?? null,
        lastError: snapshot.lastError ?? null,
      };
    },
    buildAccountSnapshot: async ({ account, runtime }) => {
      const linked = await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        linked,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        reconnectAttempts: runtime?.reconnectAttempts,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastMessageAt: runtime?.lastMessageAt ?? null,
        lastEventAt: runtime?.lastEventAt ?? null,
        lastError: runtime?.lastError ?? null,
        dmPolicy: account.dmPolicy,
        allowFrom: account.allowFrom,
      };
    },
    resolveAccountState: ({ configured }) => (configured ? "linked" : "not linked"),
    logSelfId: ({ account, runtime, includeChannelPrefix }) => {
      void loadWhatsAppChannelRuntime().then((runtimeExports) =>
        runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix),
      );
    },
  },
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
          statusSink: (next) => ctx.setStatus({ accountId: ctx.accountId, ...next }),
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
};
