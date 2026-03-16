import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatTrimmedAllowFromEntries,
  getChatChannelMeta,
  IMessageConfigSchema,
  listIMessageAccountIds,
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ResolvedIMessageAccount,
} from "openclaw/plugin-sdk/imessage";
import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { getIMessageRuntime } from "./runtime.js";
import { createIMessageSetupWizardProxy, imessageSetupAdapter } from "./setup-core.js";

const meta = getChatChannelMeta("imessage");

async function loadIMessageChannelRuntime() {
  return await import("./channel.runtime.js");
}

const imessageSetupWizard = createIMessageSetupWizardProxy(async () => ({
  imessageSetupWizard: (await loadIMessageChannelRuntime()).imessageSetupWizard,
}));

type IMessageSendFn = ReturnType<
  typeof getIMessageRuntime
>["channel"]["imessage"]["sendMessageIMessage"];

async function sendIMessageOutbound(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string;
}) {
  const send =
    resolveOutboundSendDep<IMessageSendFn>(params.deps, "imessage") ??
    getIMessageRuntime().channel.imessage.sendMessageIMessage;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.imessage?.mediaMaxMb,
    accountId: params.accountId,
  });
  return await send(params.to, params.text, {
    config: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
  });
}

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  id: "imessage",
  meta: {
    ...meta,
    aliases: ["imsg"],
    showConfigured: false,
  },
  setupWizard: imessageSetupWizard,
  pairing: {
    idLabel: "imessageSenderId",
    notifyApproval: async ({ id }) => {
      await getIMessageRuntime().channel.imessage.sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.imessage"] },
  configSchema: buildChannelConfigSchema(IMessageConfigSchema),
  config: {
    listAccountIds: (cfg) => listIMessageAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveIMessageAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultIMessageAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveIMessageConfigAllowFrom({ cfg, accountId }),
    formatAllowFrom: ({ allowFrom }) => formatTrimmedAllowFromEntries(allowFrom),
    resolveDefaultTo: ({ cfg, accountId }) => resolveIMessageConfigDefaultTo({ cfg, accountId }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "imessage",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
      });
    },
    collectWarnings: ({ account, cfg }) => {
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.imessage !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        surface: "iMessage groups",
        openScope: "any member",
        groupPolicyPath: "channels.imessage.groupPolicy",
        groupAllowFromPath: "channels.imessage.groupAllowFrom",
        mentionGated: false,
      });
    },
  },
  groups: {
    resolveRequireMention: resolveIMessageGroupRequireMention,
    resolveToolPolicy: resolveIMessageGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeIMessageMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeIMessageTargetId,
      hint: "<handle|chat_id:ID>",
    },
  },
  setup: imessageSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getIMessageRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
      const result = await sendIMessageOutbound({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        deps,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "imessage", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId }) => {
      const result = await sendIMessageOutbound({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId: accountId ?? undefined,
        deps,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "imessage", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      cliPath: null,
      dbPath: null,
    },
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
    buildChannelSummary: ({ snapshot }) =>
      buildPassiveProbedChannelStatusSummary(snapshot, {
        cliPath: snapshot.cliPath ?? null,
        dbPath: snapshot.dbPath ?? null,
      }),
    probeAccount: async ({ timeoutMs }) =>
      getIMessageRuntime().channel.imessage.probeIMessage(timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
      dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const cliPath = account.config.cliPath?.trim() || "imsg";
      const dbPath = account.config.dbPath?.trim();
      ctx.setStatus({
        accountId: account.accountId,
        cliPath,
        dbPath: dbPath ?? null,
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
      );
      return getIMessageRuntime().channel.imessage.monitorIMessageProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
