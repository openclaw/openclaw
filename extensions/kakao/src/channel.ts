import type {
  ChannelAccountSnapshot,
  ChannelDock,
  ChannelPlugin,
  MoltbotConfig,
} from "clawdbot/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
} from "clawdbot/plugin-sdk";

import {
  listKakaoAccountIds,
  resolveDefaultKakaoAccountId,
  resolveKakaoAccount,
  type ResolvedKakaoAccount,
} from "./accounts.js";
import { KakaoConfigSchema } from "./config-schema.js";
import { resolveKakaoProxyFetch } from "./proxy.js";
import { probeKakao } from "./probe.js";
import { sendMessageKakao, openAndSendMessageKakao } from "./send.js";
import { collectKakaoStatusIssues } from "./status-issues.js";

const meta = {
  id: "kakao",
  label: "KakaoWork",
  selectionLabel: "KakaoWork (Bot API)",
  docsPath: "/channels/kakao",
  docsLabel: "kakao",
  blurb: "Korea-focused enterprise messaging with KakaoWork Bot API.",
  aliases: ["kw"],
  order: 85,
  quickstartAllowFrom: true,
};

function normalizeKakaoMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(kakao|kw):/i, "");
}

export const kakaoDock: ChannelDock = {
  id: "kakao",
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveKakaoAccount({ cfg: cfg as MoltbotConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(kakao|kw):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const kakaoPlugin: ChannelPlugin<ResolvedKakaoAccount> = {
  id: "kakao",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.kakao"] },
  configSchema: buildChannelConfigSchema(KakaoConfigSchema),
  config: {
    listAccountIds: (cfg) => listKakaoAccountIds(cfg as MoltbotConfig),
    resolveAccount: (cfg, accountId) => resolveKakaoAccount({ cfg: cfg as MoltbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultKakaoAccountId(cfg as MoltbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as MoltbotConfig,
        sectionKey: "kakao",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as MoltbotConfig,
        sectionKey: "kakao",
        accountId,
        clearBaseFields: ["appKey", "keyFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.appKey?.trim()),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appKey?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveKakaoAccount({ cfg: cfg as MoltbotConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(kakao|kw):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as MoltbotConfig).channels?.kakao?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.kakao.accounts.${resolvedAccountId}.`
        : "channels.kakao.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("kakao"),
        normalizeEntry: (raw) => raw.replace(/^(kakao|kw):/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeKakaoMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        return /^\d{3,}$/.test(trimmed);
      },
      hint: "<conversationId or userId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveKakaoAccount({ cfg: cfg as MoltbotConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const peers = Array.from(
        new Set(
          (account.config.allowFrom ?? [])
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*")
            .map((entry) => entry.replace(/^(kakao|kw):/i, "")),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "kakao",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "KAKAOWORK_APP_KEY can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "KakaoWork requires app key or --key-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "kakao",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "kakao",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            kakao: {
              ...next.channels?.kakao,
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { keyFile: input.tokenFile }
                  : input.token
                    ? { appKey: input.token }
                    : {}),
            },
          },
        } as MoltbotConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          kakao: {
            ...next.channels?.kakao,
            enabled: true,
            accounts: {
              ...(next.channels?.kakao?.accounts ?? {}),
              [accountId]: {
                ...(next.channels?.kakao?.accounts?.[accountId] ?? {}),
                enabled: true,
                ...(input.tokenFile
                  ? { keyFile: input.tokenFile }
                  : input.token
                    ? { appKey: input.token }
                    : {}),
              },
            },
          },
        },
      } as MoltbotConfig;
    },
  },
  pairing: {
    idLabel: "kakaoUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(kakao|kw):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveKakaoAccount({ cfg: cfg as MoltbotConfig });
      if (!account.appKey) throw new Error("KakaoWork app key not configured");
      await openAndSendMessageKakao(id, PAIRING_APPROVED_MESSAGE, { appKey: account.appKey });
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => {
      if (!text) return [];
      if (limit <= 0 || text.length <= limit) return [text];
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > limit) {
        const window = remaining.slice(0, limit);
        const lastNewline = window.lastIndexOf("\n");
        const lastSpace = window.lastIndexOf(" ");
        let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
        if (breakIdx <= 0) breakIdx = limit;
        const rawChunk = remaining.slice(0, breakIdx);
        const chunk = rawChunk.trimEnd();
        if (chunk.length > 0) chunks.push(chunk);
        const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
        const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
        remaining = remaining.slice(nextStart).trimStart();
      }
      if (remaining.length) chunks.push(remaining);
      return chunks;
    },
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, cfg }) => {
      const result = await sendMessageKakao(to, text, {
        accountId: accountId ?? undefined,
        cfg: cfg as MoltbotConfig,
      });
      return {
        channel: "kakao",
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
    collectStatusIssues: collectKakaoStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeKakao(account.appKey, timeoutMs, resolveKakaoProxyFetch(account.config.proxy)),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.appKey?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: account.config.callbackUrl ? "callback" : "passive",
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        dmPolicy: account.config.dmPolicy ?? "pairing",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const appKey = account.appKey.trim();
      let kakaoBotLabel = "";
      const fetcher = resolveKakaoProxyFetch(account.config.proxy);
      try {
        const probe = await probeKakao(appKey, 2500, fetcher);
        const name = probe.ok ? probe.bot?.title?.trim() : null;
        if (name) kakaoBotLabel = ` (${name})`;
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
        });
      } catch {
        // ignore probe errors
      }
      ctx.log?.info(`[${account.accountId}] starting provider${kakaoBotLabel}`);
      const { monitorKakaoProvider } = await import("./monitor.js");
      return monitorKakaoProvider({
        appKey,
        account,
        config: ctx.cfg as MoltbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        callbackUrl: account.config.callbackUrl,
        callbackPath: account.config.callbackPath,
        fetcher,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
