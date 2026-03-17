import { buildAccountScopedAllowlistConfigEditor } from "openclaw/plugin-sdk/compat";
import { buildAgentSessionKey, type RoutePeer } from "openclaw/plugin-sdk/core";
import {
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  formatTrimmedAllowFromEntries,
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/imessage";
import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { getIMessageRuntime } from "./runtime.js";
import { imessageSetupAdapter } from "./setup-core.js";
import { createIMessagePluginBase, imessageSetupWizard } from "./shared.js";
import { normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

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

function buildIMessageBaseSessionKey(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "imessage",
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

function resolveIMessageOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const parsed = parseIMessageTarget(params.target);
  if (parsed.kind === "handle") {
    const handle = normalizeIMessageHandle(parsed.to);
    if (!handle) {
      return null;
    }
    const peer: RoutePeer = { kind: "direct", id: handle };
    const baseSessionKey = buildIMessageBaseSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      accountId: params.accountId,
      peer,
    });
    return {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: "direct" as const,
      from: `imessage:${handle}`,
      to: `imessage:${handle}`,
    };
  }

  const peerId =
    parsed.kind === "chat_id"
      ? String(parsed.chatId)
      : parsed.kind === "chat_guid"
        ? parsed.chatGuid
        : parsed.chatIdentifier;
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { kind: "group", id: peerId };
  const baseSessionKey = buildIMessageBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const toPrefix =
    parsed.kind === "chat_id"
      ? "chat_id"
      : parsed.kind === "chat_guid"
        ? "chat_guid"
        : "chat_identifier";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "group" as const,
    from: `imessage:group:${peerId}`,
    to: `${toPrefix}:${peerId}`,
  };
}

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  ...createIMessagePluginBase({
    setupWizard: imessageSetupWizard,
    setup: imessageSetupAdapter,
  }),
  pairing: {
    idLabel: "imessageSenderId",
    notifyApproval: async ({ id }) => {
      await getIMessageRuntime().channel.imessage.sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    readConfig: ({ cfg, accountId }) => {
      const account = resolveIMessageAccount({ cfg, accountId });
      return {
        dmAllowFrom: (account.config.allowFrom ?? []).map(String),
        groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
        dmPolicy: account.config.dmPolicy,
        groupPolicy: account.config.groupPolicy,
      };
    },
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: "imessage",
      normalize: ({ values }) => formatTrimmedAllowFromEntries(values),
      resolvePaths: (scope) => ({
        readPaths: [[scope === "dm" ? "allowFrom" : "groupAllowFrom"]],
        writePath: [scope === "dm" ? "allowFrom" : "groupAllowFrom"],
      }),
    }),
  },
  groups: {
    resolveRequireMention: resolveIMessageGroupRequireMention,
    resolveToolPolicy: resolveIMessageGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeIMessageMessagingTarget,
    resolveOutboundSessionRoute: (params) => resolveIMessageOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: looksLikeIMessageTargetId,
      hint: "<handle|chat_id:ID>",
    },
  },
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
