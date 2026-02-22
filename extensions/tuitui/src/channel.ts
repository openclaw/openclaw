import type {
  ChannelAccountSnapshot,
  ChannelDock,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { readFileSync } from "node:fs";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  chunkTextForOutbound,
  formatAllowFromLowercase,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelAccountConfigBasePath,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";
import {
  listTuituiAccountIds,
  resolveDefaultTuituiAccountId,
  resolveTuituiAccount,
  type ResolvedTuituiAccount,
} from "./accounts.js";
import { tuituiMessageActions } from "./actions.js";
import { modifyTuituiWebhookUrl } from "./api.js";
import { TuituiConfigSchema } from "./config-schema.js";
import { monitorTuituiProvider } from "./monitor.js";
import { tuituiOnboardingAdapter } from "./onboarding.js";
import { probeTuituiAccount } from "./probe.js";
import { getTuituiRuntime } from "./runtime.js";
import { sendMessageTuitui } from "./send.js";
import { collectTuituiStatusIssues } from "./status-issues.js";
import { getTuituiWebhookDefaultPath, registerTuituiWebhookTarget } from "./webhook.js";

const meta = {
  id: "tuitui",
  label: "推推",
  selectionLabel: "推推 (Tuitui)",
  docsPath: "/channels/tuitui",
  docsLabel: "tuitui",
  blurb: "推推消息通道集成。",
  aliases: ["tt"],
  order: 85,
  quickstartAllowFrom: true,
};

function normalizeTuituiMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(tuitui|tt):/i, "");
}

export const tuituiDock: ChannelDock = {
  id: "tuitui",
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 50000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTuituiAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(tuitui|tt):/i }),
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const tuituiPlugin: ChannelPlugin<ResolvedTuituiAccount> = {
  id: "tuitui",
  meta,
  onboarding: tuituiOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.tuitui"] },
  configSchema: buildChannelConfigSchema(TuituiConfigSchema),
  config: {
    listAccountIds: (cfg) => listTuituiAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTuituiAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTuituiAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "tuitui",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "tuitui",
        accountId,
        clearBaseFields: ["appId", "secret", "secretFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.appId?.trim() && account.secret?.trim()),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId?.trim() && account.secret?.trim()),
      tokenSource: account.credentialsSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTuituiAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(tuitui|tt):/i }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = resolveChannelAccountConfigBasePath({
        cfg,
        channelKey: "tuitui",
        accountId: resolvedAccountId,
      });
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("tuitui"),
        normalizeEntry: (raw) => raw.replace(/^(tuitui|tt):/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  actions: tuituiMessageActions,
  messaging: {
    normalizeTarget: normalizeTuituiMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw?.trim()),
      hint: "域账号或群ID",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTuituiAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const peers = Array.from(
        new Set(
          (account.config.allowFrom ?? [])
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*")
            .map((entry) => entry.replace(/^(tuitui|tt):/i, "")),
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
        cfg,
        channelKey: "tuitui",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "TUITUI_APPID/SECRET 仅可用于 default 账户。";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "推推需要 appId+secret：--token appId:secret 或 --token-file（或 --use-env）。";
      }
      if (input.token && !input.tokenFile && !input.useEnv && !input.token.includes(":")) {
        return "推推 --token 请使用 appId:secret 格式。";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "tuitui",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "tuitui",
            })
          : namedConfig;

      let appIdSecret: { appId: string; secret: string } | null = null;
      if (!input.useEnv && input.token?.includes(":")) {
        const colonIdx = input.token.indexOf(":");
        const a = input.token.slice(0, colonIdx).trim();
        const s = input.token.slice(colonIdx + 1).trim();
        if (a && s) appIdSecret = { appId: a, secret: s };
      }
      if (!appIdSecret && input.tokenFile) {
        try {
          const content = readFileSync(input.tokenFile, "utf8").trim();
          const lines = content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          if (lines.length >= 2) appIdSecret = { appId: lines[0], secret: lines[1] };
        } catch {
          // ignore
        }
      }

      const creds = appIdSecret ? { appId: appIdSecret.appId, secret: appIdSecret.secret } : {};
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            tuitui: { ...next.channels?.tuitui, enabled: true, ...creds },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          tuitui: {
            ...next.channels?.tuitui,
            enabled: true,
            accounts: {
              ...next.channels?.tuitui?.accounts,
              [accountId]: {
                ...next.channels?.tuitui?.accounts?.[accountId],
                enabled: true,
                ...creds,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  pairing: {
    idLabel: "tuituiUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(tuitui|tt):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveTuituiAccount({ cfg });
      if (!account.appId || !account.secret) {
        throw new Error("推推 appId/secret 未配置");
      }
      await sendMessageTuitui(id, PAIRING_APPROVED_MESSAGE, {
        appId: account.appId,
        secret: account.secret,
        cfg,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 50000,
    sendText: async ({ to, text, accountId, cfg }) => {
      const result = await sendMessageTuitui(to, text, {
        accountId: accountId ?? undefined,
        cfg,
      });
      return {
        channel: "tuitui",
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
    collectStatusIssues: collectTuituiStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.credentialsSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeTuituiAccount(account.appId, account.secret, timeoutMs),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.appId?.trim() && account.secret?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        credentialsSource: account.credentialsSource,
        tokenSource: account.credentialsSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        dmPolicy: account.config.dmPolicy ?? "pairing",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const path = ctx.account.config.webhookPath?.trim() || getTuituiWebhookDefaultPath();
      const baseUrl = ctx.account.config.webhookBaseUrl?.trim();
      if (baseUrl && ctx.account.appId && ctx.account.secret) {
        const fullUrl = baseUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
        const result = await modifyTuituiWebhookUrl(ctx.account.appId, ctx.account.secret, fullUrl);
        if (!result.ok) {
          ctx.log?.error?.(`[${ctx.account.accountId}] 推推改收消息回调url失败: ${result.error}`);
        } else {
          ctx.log?.info?.(
            `[${ctx.account.accountId}] 推推收消息回调已设为 ${fullUrl}（约 5 分钟后生效）`,
          );
        }
      }
      const unregister = registerTuituiWebhookTarget({
        path,
        account: ctx.account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        core: getTuituiRuntime(),
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      ctx.abortSignal.addEventListener("abort", () => unregister(), { once: true });
      ctx.log?.info(`[${ctx.account.accountId}] 推推 provider 启动，webhook path=${path}`);
      return monitorTuituiProvider({
        account: ctx.account,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
