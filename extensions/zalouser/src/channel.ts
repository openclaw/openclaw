import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelDock,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelPlugin,
  OpenClawConfig,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/compat";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  deleteAccountFromConfigSection,
  formatAllowFromLowercase,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  resolvePreferredOpenClawTmpDir,
  resolveChannelAccountConfigBasePath,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/compat";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  getZcaUserInfo,
  checkZcaAuthenticated,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import { ZalouserConfigSchema } from "./config-schema.js";
import { buildZalouserGroupCandidates, findZalouserGroupEntry } from "./group-policy.js";
import { resolveZalouserReactionMessageIds } from "./message-sid.js";
import { zalouserOnboardingAdapter } from "./onboarding.js";
import { probeZalouser } from "./probe.js";
import { sendMessageZalouser, sendReactionZalouser } from "./send.js";
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

const meta = {
  id: "zalouser",
  label: "Zalo Personal",
  selectionLabel: "Zalo (Personal Account)",
  docsPath: "/channels/zalouser",
  docsLabel: "zalouser",
  blurb: "Zalo personal account via QR code login.",
  aliases: ["zlu"],
  order: 85,
  quickstartAllowFrom: true,
};

function resolveZalouserQrProfile(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (!normalized || normalized === DEFAULT_ACCOUNT_ID) {
    return process.env.ZALOUSER_PROFILE?.trim() || process.env.ZCA_PROFILE?.trim() || "default";
  }
  return normalized;
}

async function writeQrDataUrlToTempFile(
  qrDataUrl: string,
  profile: string,
): Promise<string | null> {
  const trimmed = qrDataUrl.trim();
  const match = trimmed.match(/^data:image\/png;base64,(.+)$/i);
  const base64 = (match?.[1] ?? "").trim();
  if (!base64) {
    return null;
  }
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
  const filePath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-zalouser-qr-${safeProfile}.png`,
  );
  await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
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

function resolveZalouserGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveZalouserAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const entry = findZalouserGroupEntry(
    groups,
    buildZalouserGroupCandidates({
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      includeWildcard: true,
    }),
  );
  return entry?.tools;
}

function resolveZalouserRequireMention(params: ChannelGroupContext): boolean {
  const account = resolveZalouserAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const entry = findZalouserGroupEntry(
    groups,
    buildZalouserGroupCandidates({
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      includeWildcard: true,
    }),
  );
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  return true;
}

const zalouserMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listZalouserAccountIds(cfg)
      .map((accountId) => resolveZalouserAccountSync({ cfg, accountId }))
      .filter((account) => account.enabled);
    if (accounts.length === 0) {
      return [];
    }
    return ["react"];
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

export const zalouserDock: ChannelDock = {
  id: "zalouser",
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 2000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZalouserAccountSync({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalouser|zlu):/i }),
  },
  groups: {
    resolveRequireMention: resolveZalouserRequireMention,
    resolveToolPolicy: resolveZalouserGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  id: "zalouser",
  meta,
  onboarding: zalouserOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.zalouser"] },
  configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
  config: {
    listAccountIds: (cfg) => listZalouserAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZalouserAccountSync({ cfg: cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZalouserAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg,
        sectionKey: "zalouser",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg,
        sectionKey: "zalouser",
        accountId,
        clearBaseFields: [
          "profile",
          "name",
          "dmPolicy",
          "allowFrom",
          "groupPolicy",
          "groups",
          "messagePrefix",
        ],
      }),
    isConfigured: async (account) => await checkZcaAuthenticated(account.profile),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZalouserAccountSync({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalouser|zlu):/i }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = resolveChannelAccountConfigBasePath({
        cfg,
        channelKey: "zalouser",
        accountId: resolvedAccountId,
      });
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zalouser"),
        normalizeEntry: (raw) => raw.replace(/^(zalouser|zlu):/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: resolveZalouserRequireMention,
    resolveToolPolicy: resolveZalouserGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  actions: zalouserMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "zalouser",
        accountId,
        name,
      }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "zalouser",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "zalouser",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zalouser: {
              ...next.channels?.zalouser,
              enabled: true,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zalouser: {
            ...next.channels?.zalouser,
            enabled: true,
            accounts: {
              ...next.channels?.zalouser?.accounts,
              [accountId]: {
                ...next.channels?.zalouser?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^(zalouser|zlu):/i, "");
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        return /^\d{3,}$/.test(trimmed);
      },
      hint: "<threadId>",
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
          id: String(group.groupId),
          name: group.name ?? null,
          raw: group,
        }),
      );
      return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    },
    listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const members = await listZaloGroupMembers(account.profile, groupId);
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
  pairing: {
    idLabel: "zalouserUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(zalouser|zlu):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg });
      const authenticated = await checkZcaAuthenticated(account.profile);
      if (!authenticated) {
        throw new Error("Zalouser not authenticated");
      }
      await sendMessageZalouser(id, "Your pairing request has been approved.", {
        profile: account.profile,
      });
    },
  },
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
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 2000,
    sendPayload: async (ctx) => {
      const text = ctx.payload.text ?? "";
      const urls = ctx.payload.mediaUrls?.length
        ? ctx.payload.mediaUrls
        : ctx.payload.mediaUrl
          ? [ctx.payload.mediaUrl]
          : [];
      if (!text && urls.length === 0) {
        return { channel: "zalouser", messageId: "" };
      }
      if (urls.length > 0) {
        let lastResult = await zalouserPlugin.outbound!.sendMedia!({
          ...ctx,
          text,
          mediaUrl: urls[0],
        });
        for (let i = 1; i < urls.length; i++) {
          lastResult = await zalouserPlugin.outbound!.sendMedia!({
            ...ctx,
            text: "",
            mediaUrl: urls[i],
          });
        }
        return lastResult;
      }
      const outbound = zalouserPlugin.outbound!;
      const limit = outbound.textChunkLimit;
      const chunks = limit && outbound.chunker ? outbound.chunker(text, limit) : [text];
      let lastResult: Awaited<ReturnType<NonNullable<typeof outbound.sendText>>>;
      for (const chunk of chunks) {
        lastResult = await outbound.sendText!({ ...ctx, text: chunk });
      }
      return lastResult!;
    },
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const result = await sendMessageZalouser(to, text, { profile: account.profile });
      return {
        channel: "zalouser",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, mediaLocalRoots }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
      const result = await sendMessageZalouser(to, text, {
        profile: account.profile,
        mediaUrl,
        mediaLocalRoots,
      });
      return {
        channel: "zalouser",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
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
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => probeZalouser(account.profile, timeoutMs),
    buildAccountSnapshot: async ({ account, runtime }) => {
      const configured = await checkZcaAuthenticated(account.profile);
      const configError = "not authenticated";
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: configured ? (runtime?.lastError ?? null) : (runtime?.lastError ?? configError),
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
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
      ctx.log?.info(`[${account.accountId}] starting zalouser provider${userLabel}`);
      const { monitorZalouserProvider } = await import("./monitor.js");
      return monitorZalouserProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
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
