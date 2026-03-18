import { buildAccountScopedAllowlistConfigEditor } from "openclaw/plugin-sdk/allowlist-config-edit";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";
import { buildOutboundBaseSessionKey } from "openclaw/plugin-sdk/core";
import {
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  formatTrimmedAllowFromEntries,
  normalizeIMessageMessagingTarget,
  type ChannelPlugin,
} from "../runtime-api.js";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { type RoutePeer } from "openclaw/plugin-sdk/routing";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import { getIMessageRuntime } from "./runtime.js";
import { imessageSetupAdapter } from "./setup-core.js";
import {
  collectIMessageSecurityWarnings,
  createIMessagePluginBase,
  imessageResolveDmPolicy,
  imessageSetupWizard,
} from "./shared.js";
import {
  inferIMessageTargetChatType,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const loadIMessageChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

function buildIMessageBaseSessionKey(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "imessage" });
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
    notifyApproval: async ({ id }) =>
      await (await loadIMessageChannelRuntime()).notifyIMessageApproval(id),
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
  security: {
    resolveDmPolicy: imessageResolveDmPolicy,
    collectWarnings: collectIMessageSecurityWarnings,
  },
  groups: {
    resolveRequireMention: resolveIMessageGroupRequireMention,
    resolveToolPolicy: resolveIMessageGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeIMessageMessagingTarget,
    inferTargetChatType: ({ to }) => inferIMessageTargetChatType(to),
    resolveOutboundSessionRoute: (params) => resolveIMessageOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: looksLikeIMessageExplicitTargetId,
      hint: "<handle|chat_id:ID>",
      resolveTarget: async ({ normalized }) => {
        const to = normalized?.trim();
        if (!to) {
          return null;
        }
        const chatType = inferIMessageTargetChatType(to);
        if (!chatType) {
          return null;
        }
        return {
          to,
          kind: chatType === "direct" ? "user" : "group",
          source: "normalized" as const,
        };
      },
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getIMessageRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
      const result = await (
        await loadIMessageChannelRuntime()
      ).sendIMessageOutbound({
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
      const result = await (
        await loadIMessageChannelRuntime()
      ).sendIMessageOutbound({
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
      await (await loadIMessageChannelRuntime()).probeIMessageAccount(timeoutMs),
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
    startAccount: async (ctx) =>
      await (await loadIMessageChannelRuntime()).startIMessageGatewayAccount(ctx),
  },
};
