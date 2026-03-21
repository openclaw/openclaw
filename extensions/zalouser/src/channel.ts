import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-pairing";
import {
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelPlugin,
  OpenClawConfig,
  GroupToolPolicyConfig,
} from "../runtime-api.js";
import {
  buildBaseAccountStatusSnapshot,
  DEFAULT_ACCOUNT_ID,
  isDangerousNameMatchingEnabled,
  isNumericTargetId,
  normalizeAccountId,
  sendPayloadWithChunkedTextAndMedia,
} from "../runtime-api.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  getZcaUserInfo,
  checkZcaAuthenticated,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import { buildZalouserGroupCandidates, findZalouserGroupEntry } from "./group-policy.js";
import { resolveZalouserReactionMessageIds } from "./message-sid.js";
import { probeZalouser } from "./probe.js";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";
import { getZalouserRuntime } from "./runtime.js";
import { sendMessageZalouser, sendReactionZalouser } from "./send.js";
import {
  normalizeZalouserTarget,
  parseZalouserDirectoryGroupId,
  parseZalouserOutboundTarget,
  resolveZalouserOutboundSessionRoute,
} from "./session-route.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { createZalouserPluginBase } from "./shared.js";
import { collectZalouserStatusIssues } from "./status-issues.js";
import {
  listZaloFriendsMatching,
  listZaloGroupMembers,
  listZaloGroupsMatching,
  logoutZaloProfile,
  startZaloQrLogin,
  waitForZaloQrLogin,
  getZaloUserInfo,
} from "./zalo-js.js";

const ZALOUSER_TEXT_CHUNK_LIMIT = 2000;

function resolveZalouserQrProfile(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (!normalized || normalized === DEFAULT_ACCOUNT_ID) {
    return process.env.ZALOUSER_PROFILE?.trim() || process.env.ZCA_PROFILE?.trim() || "default";
  }
  return normalized;
}

function resolveZalouserOutboundChunkMode(cfg: OpenClawConfig, accountId?: string) {
  return getZalouserRuntime().channel.text.resolveChunkMode(cfg, "zalouser", accountId);
}

function resolveZalouserOutboundTextChunkLimit(cfg: OpenClawConfig, accountId?: string) {
  return getZalouserRuntime().channel.text.resolveTextChunkLimit(cfg, "zalouser", accountId, {
    fallbackLimit: ZALOUSER_TEXT_CHUNK_LIMIT,
  });
}

function mapUser(params: {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "user",
    id: params.id,
    name: params.name ?? undefined,
    avatarUrl: params.avatarUrl ?? undefined,
    raw: params.raw,
  };
}

function mapGroup(params: {
  id: string;
  name?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "group",
    id: params.id,
    name: params.name ?? undefined,
    raw: params.raw,
  };
}

function resolveZalouserGroupPolicyEntry(params: ChannelGroupContext) {
  const account = resolveZalouserAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  return findZalouserGroupEntry(
    groups,
    buildZalouserGroupCandidates({
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      includeWildcard: true,
      allowNameMatching: isDangerousNameMatchingEnabled(account.config),
    }),
  );
}

function resolveZalouserGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveZalouserGroupPolicyEntry(params)?.tools;
}

function resolveZalouserRequireMention(params: ChannelGroupContext): boolean {
  const entry = resolveZalouserGroupPolicyEntry(params);
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  return true;
}

const resolveZalouserDmPolicy = createScopedDmSecurityResolver<ResolvedZalouserAccount>({
  channelKey: "zalouser",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.replace(/^(zalouser|zlu):/i, ""),
});

const zalouserMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => {
    const accounts = listZalouserAccountIds(cfg)
      .map((accountId) => resolveZalouserAccountSync({ cfg, accountId }))
      .filter((account) => account.enabled);
    if (accounts.length === 0) {
      return null;
    }
    return { actions: ["react"] };
  },
  supportsAction: ({ action }) => action === "react",
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react") {
      throw new Error(`Zalouser action ${action} not supported`);
    }
    const account = resolveZalouserAccountSync({ cfg, accountId });
    const threadId =
      (typeof params.threadId === "string" ? params.threadId.trim() : "") ||
      (typeof params.to === "string" ? params.to.trim() : "") ||
      (typeof params.chatId === "string" ? params.chatId.trim() : "") ||
      (toolContext?.currentChannelId?.trim() ?? "");
    if (!threadId) {
      throw new Error("Zalouser react requires threadId (or to/chatId).");
    }
    const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
    if (!emoji) {
      throw new Error("Zalouser react requires emoji.");
    }
    const ids = resolveZalouserReactionMessageIds({
      messageId: typeof params.messageId === "string" ? params.messageId : undefined,
      cliMsgId: typeof params.cliMsgId === "string" ? params.cliMsgId : undefined,
      currentMessageId: toolContext?.currentMessageId,
    });
    if (!ids) {
      throw new Error(
        "Zalouser react requires messageId + cliMsgId (or a current message context id).",
      );
    }
    const result = await sendReactionZalouser({
      profile: account.profile,
      threadId,
      isGroup: params.isGroup === true,
      msgId: ids.msgId,
      cliMsgId: ids.cliMsgId,
      emoji,
      remove: params.remove === true,
    });
    if (!result.ok) {
      throw new Error(result.error || "Failed to react on Zalo message");
    }
    return {
      content: [
        {
          type: "text" as const,
          text:
            params.remove === true
              ? `Removed reaction ${emoji} from ${ids.msgId}`
              : `Reacted ${emoji} on ${ids.msgId}`,
        },
      ],
      details: {
        messageId: ids.msgId,
        cliMsgId: ids.cliMsgId,
        threadId,
      },
    };
  },
};

export const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  ...createZalouserPluginBase({
    setupWizard: zalouserSetupWizard,
    setup: zalouserSetupAdapter,
  }),
  security: {
    resolveDmPolicy: resolveZalouserDmPolicy,
  },
  groups: {
    resolveRequireMention: resolveZalouserRequireMention,
    resolveToolPolicy: resolveZalouserGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: createStaticReplyToModeResolver("off"),
  },
  actions: zalouserMessageActions,
  messaging: {
    normalizeTarget: (raw) => normalizeZalouserTarget(raw),
    resolveOutboundSessionRoute: (params) => resolveZalouserOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: (raw) => {
        const normalized = normalizeZalouserTarget(raw);
        if (!normalized) {
          return false;
        }
        if (/^group:[^\s]+$/i.test(normalized) || /^user:[^\s]+$/i.test(normalized)) {
          return true;
        }
        return isNumericTargetId(normalized);
      },
      hint: "<user:id|group:id>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const parsed = await getZaloUserInfo(account.profile);
      if (!parsed?.userId) {
        return null;
      }
      return mapUser({
        id: String(parsed.userId),
        name: parsed.displayName ?? null,
        avatarUrl: parsed.avatar ?? null,
        raw: parsed,
      });
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const friends = await listZaloFriendsMatching(account.profile, query);
      const rows = friends.map((friend) =>
        mapUser({
          id: String(friend.userId),
          name: friend.displayName ?? null,
          avatarUrl: friend.avatar ?? null,
          raw: friend,
        }),
      );
      return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const groups = await listZaloGroupsMatching(account.profile, query);
      const rows = groups.map((group) =>
        mapGroup({
          id: `group:${String(group.groupId)}`,
          name: group.name ?? null,
          raw: group,
        }),
      );
      return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    },
    listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const normalizedGroupId = parseZalouserDirectoryGroupId(groupId);
      const members = await listZaloGroupMembers(account.profile, normalizedGroupId);
      const rows = members.map((member) =>
        mapUser({
          id: member.userId,
          name: member.displayName,
          avatarUrl: member.avatar ?? null,
          raw: member,
        }),
      );
      return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    },
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
      const results = [];
      for (const input of inputs) {
        const trimmed = input.trim();
        if (!trimmed) {
          results.push({ input, resolved: false, note: "empty input" });
          continue;
        }
        if (/^\d+$/.test(trimmed)) {
          results.push({ input, resolved: true, id: trimmed });
          continue;
        }
        try {
          const account = resolveZalouserAccountSync({
            cfg: cfg,
            accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          });
          if (kind === "user") {
            const friends = await listZaloFriendsMatching(account.profile, trimmed);
            const best = friends[0];
            results.push({
              input,
              resolved: Boolean(best?.userId),
              id: best?.userId,
              name: best?.displayName,
              note: friends.length > 1 ? "multiple matches; chose first" : undefined,
            });
          } else {
            const groups = await listZaloGroupsMatching(account.profile, trimmed);
            const best =
              groups.find((group) => group.name.toLowerCase() === trimmed.toLowerCase()) ??
              groups[0];
            results.push({
              input,
              resolved: Boolean(best?.groupId),
              id: best?.groupId,
              name: best?.name,
              note: groups.length > 1 ? "multiple matches; chose first" : undefined,
            });
          }
        } catch (err) {
          runtime.error?.(`zalouser resolve failed: ${String(err)}`);
          results.push({ input, resolved: false, note: "lookup failed" });
        }
      }
      return results;
    },
  },
  pairing: createTextPairingAdapter({
    idLabel: "zalouserUserId",
    message: "Your pairing request has been approved.",
    normalizeAllowEntry: createPairingPrefixStripper(/^(zalouser|zlu):/i),
    notify: async ({ cfg, id, message }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg });
      const authenticated = await checkZcaAuthenticated(account.profile);
      if (!authenticated) {
        throw new Error("Zalouser not authenticated");
      }
      await sendMessageZalouser(id, message, {
        profile: account.profile,
      });
    },
  }),
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveZalouserAccountSync({
        cfg: cfg,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      });

      runtime.log(
        `Generating QR login for Zalo Personal (account: ${account.accountId}, profile: ${account.profile})...`,
      );

      const started = await startZaloQrLogin({
        profile: account.profile,
        timeoutMs: 35_000,
      });
      if (!started.qrDataUrl) {
        throw new Error(started.message || "Failed to start QR login");
      }

      const qrPath = await writeQrDataUrlToTempFile(started.qrDataUrl, account.profile);
      if (qrPath) {
        runtime.log(`Scan QR image: ${qrPath}`);
      } else {
        runtime.log("QR generated but could not be written to a temp file.");
      }

      const waited = await waitForZaloQrLogin({ profile: account.profile, timeoutMs: 180_000 });
      if (!waited.connected) {
        throw new Error(waited.message || "Zalouser login failed");
      }

      runtime.log(waited.message);
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getZalouserRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    sendPayload: async (ctx) =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        sendText: (nextCtx) => zalouserPlugin.outbound!.sendText!(nextCtx),
        sendMedia: (nextCtx) => zalouserPlugin.outbound!.sendMedia!(nextCtx),
        emptyResult: createEmptyChannelResult("zalouser"),
      }),
    ...createRawChannelSendResultAdapter({
      channel: "zalouser",
      sendText: async ({ to, text, accountId, cfg }) => {
        const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
        const target = parseZalouserOutboundTarget(to);
        return await sendMessageZalouser(target.threadId, text, {
          profile: account.profile,
          isGroup: target.isGroup,
          textMode: "markdown",
          textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
          textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId),
        });
      },
      sendMedia: async ({ to, text, mediaUrl, accountId, cfg, mediaLocalRoots }) => {
        const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
        const target = parseZalouserOutboundTarget(to);
        return await sendMessageZalouser(target.threadId, text, {
          profile: account.profile,
          isGroup: target.isGroup,
          mediaUrl,
          mediaLocalRoots,
          textMode: "markdown",
          textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
          textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId),
        });
      },
    }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectZalouserStatusIssues,
    buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) => probeZalouser(account.profile, timeoutMs),
    buildAccountSnapshot: async ({ account, runtime }) => {
      const configured = await checkZcaAuthenticated(account.profile);
      const configError = "not authenticated";
      const base = buildBaseAccountStatusSnapshot({
        account: {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
        },
        runtime: configured
          ? runtime
          : { ...runtime, lastError: runtime?.lastError ?? configError },
      });
      return {
        ...base,
        dmPolicy: account.config.dmPolicy ?? "pairing",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      let userLabel = "";
      try {
        const userInfo = await getZcaUserInfo(account.profile);
        if (userInfo?.displayName) {
          userLabel = ` (${userInfo.displayName})`;
        }
        ctx.setStatus({
          accountId: account.accountId,
          profile: userInfo,
        });
      } catch {
        // ignore probe errors
      }
      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
      ctx.log?.info(`[${account.accountId}] starting zalouser provider${userLabel}`);
      const { monitorZalouserProvider } = await import("./monitor.js");
      return monitorZalouserProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
      });
    },
    loginWithQrStart: async (params) => {
      const profile = resolveZalouserQrProfile(params.accountId);
      return await startZaloQrLogin({
        profile,
        force: params.force,
        timeoutMs: params.timeoutMs,
      });
    },
    loginWithQrWait: async (params) => {
      const profile = resolveZalouserQrProfile(params.accountId);
      return await waitForZaloQrLogin({
        profile,
        timeoutMs: params.timeoutMs,
      });
    },
    logoutAccount: async (ctx) =>
      await logoutZaloProfile(ctx.account.profile || resolveZalouserQrProfile(ctx.accountId)),
  },
};

export type { ResolvedZalouserAccount };
