import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  dingtalkOutbound,
  formatPairingApproveHint,
  listDingTalkAccountIds,
  monitorDingTalkProvider,
  normalizeDingTalkTarget,
  PAIRING_APPROVED_MESSAGE,
  probeDingTalk,
  readDingTalkAllowFromStore,
  readDingTalkKnownUsers,
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
  resolveDingTalkConfig,
  resolveDingTalkGroupRequireMention,
  setAccountEnabledInConfigSection,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type ResolvedDingTalkAccount,
} from "openclaw/plugin-sdk";
import { DingTalkConfigSchema } from "./config-schema.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";

const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk Open Platform",
  detailLabel: "DingTalk Bot",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "DingTalk bot via Stream mode with AI Card streaming.",
  aliases: ["dd", "ding", "dingtalk-connector"],
  order: 70,
  quickstartAllowFrom: true,
};

const normalizeAllowEntry = (entry: string) =>
  entry.replace(/^(dingtalk|dingtalk-connector|dd|ding):/i, "").trim();

const buildPeerDirectoryEntries = async (params: {
  cfg: Parameters<typeof resolveDingTalkConfig>[0]["cfg"];
  accountId?: string | null;
}) => {
  const resolved = resolveDingTalkConfig({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const configAllowFrom = resolved.allowFrom
    .map((entry) => String(entry).trim())
    .filter((entry) => Boolean(entry) && entry !== "*")
    .map((entry) => normalizeAllowEntry(entry));
  const storeAllowFrom = await readDingTalkAllowFromStore().catch(() => []);
  const knownUsers = await readDingTalkKnownUsers().catch(() => []);
  const knownById = new Map(
    knownUsers.map((item) => [normalizeAllowEntry(item.userId), item.name] as const),
  );
  const userIds = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]))
    .map((entry) => normalizeAllowEntry(entry))
    .filter(Boolean);
  return userIds.map((id) => {
    const name = knownById.get(id);
    return name ? ({ kind: "user", id, name } as const) : ({ kind: "user", id } as const);
  });
};

export const dingtalkPlugin: ChannelPlugin<ResolvedDingTalkAccount> = {
  id: "dingtalk",
  meta,
  onboarding: dingtalkOnboardingAdapter,
  pairing: {
    idLabel: "dingTalkUserId",
    normalizeAllowEntry,
    notifyApproval: async ({ cfg, id }) => {
      await dingtalkOutbound.sendText({ cfg, to: id, text: PAIRING_APPROVED_MESSAGE });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- 钉钉提醒/定时主动发送前先读取当前会话接收人；优先 `deliveryContext.to`，其次 `lastTo`。两者都没有时先向用户索要 `user:<id>` 或 `group:<id>`。",
      '- 钉钉定时任务必须使用：`job.sessionTarget="isolated"` + `job.payload.kind="agentTurn"` + `job.delivery.mode="announce"` + `job.delivery.channel="dingtalk"`，正文放 `job.payload.message`。',
      '- 禁止使用：`job.sessionTarget="main"`、`job.payload.kind="systemEvent"`、`[[reply_to_current]]`、`[[reply_to:*]]`，以及把“最后联系人”等自然语言字面量当作 `to/target`。',
      "- 面向用户的确认回复只能描述结果本身，不写实现细节。禁止输出 `isolated`、`agentTurn`、`session_status`、`deliveryContext`、`lastTo`、`channel`、`to` 等内部术语或字段名；禁止出现“使用独立会话（isolated）执行”“直接指定钉钉通道和接收人”这类说明句。",
      "- 用户可见确认语固定模板：第一句“已设置{时间}提醒：{内容}。”；可选第二句“到时我会在钉钉提醒你。”；禁止列表/项目符号/步骤说明。",
    ],
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  outbound: dingtalkOutbound,
  messaging: {
    normalizeTarget: normalizeDingTalkTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = (normalized ?? raw).trim();
        if (!value) {
          return false;
        }
        if (/^(user|group|dm):/i.test(value)) {
          return true;
        }
        if (/^\d{8,}$/.test(value)) {
          return true;
        }
        return value.includes("=") || value.length > 30;
      },
      hint: "<userId|groupId>",
    },
  },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  config: {
    listAccountIds: (cfg) => listDingTalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDingTalkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDingTalkAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg,
        sectionKey: "dingtalk",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg,
        sectionKey: "dingtalk",
        accountId,
        clearBaseFields: ["clientId", "clientSecret", "clientSecretFile", "name"],
      }),
    isConfigured: (account) => account.tokenSource !== "none",
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.tokenSource !== "none",
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveDingTalkConfig({ cfg, accountId: accountId ?? undefined }).allowFrom.map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? entry : normalizeAllowEntry(entry)))
        .map((entry) => (entry === "*" ? entry : entry.toLowerCase())),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.dingtalk?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.dingtalk.accounts.${resolvedAccountId}.`
        : "channels.dingtalk.";
      return {
        policy: account.config.dmPolicy ?? "open",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("dingtalk"),
        normalizeEntry: normalizeAllowEntry,
      };
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      if (!groupId) {
        return true;
      }
      return resolveDingTalkGroupRequireMention({
        cfg,
        accountId: accountId ?? undefined,
        chatId: groupId,
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const peers = await buildPeerDirectoryEntries({ cfg, accountId: accountId ?? undefined });
      const normalizedQuery = query?.trim().toLowerCase() ?? "";
      return peers
        .filter((entry) => {
          if (!normalizedQuery) {
            return true;
          }
          const idMatch = entry.id.toLowerCase().includes(normalizedQuery);
          const nameMatch = entry.name?.toLowerCase().includes(normalizedQuery) ?? false;
          return idMatch || nameMatch;
        })
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((entry) => ({ ...entry }));
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const resolved = resolveDingTalkConfig({ cfg, accountId: accountId ?? undefined });
      const normalizedQuery = query?.trim().toLowerCase() ?? "";
      const groups = Object.keys(resolved.groups ?? {})
        .filter((id) => (normalizedQuery ? id.toLowerCase().includes(normalizedQuery) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      if (!normalizedQuery) {
        return groups;
      }
      const peers = await buildPeerDirectoryEntries({ cfg, accountId: accountId ?? undefined });
      const matchedPeers = peers.filter((entry) => {
        const idMatch = entry.id.toLowerCase().includes(normalizedQuery);
        const nameMatch = entry.name?.toLowerCase().includes(normalizedQuery) ?? false;
        return idMatch || nameMatch;
      });
      const merged = [...groups, ...matchedPeers];
      return merged.slice(0, limit && limit > 0 ? limit : undefined);
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
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        if (account.tokenSource === "none") {
          issues.push({
            channel: "dingtalk",
            accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
            kind: "config",
            message: "DingTalk app key/secret not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: async ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeDingTalk(account.config.clientId ?? "", account.config.clientSecret ?? "", timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = account.tokenSource !== "none";
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
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
    logSelfId: ({ account, runtime }) => {
      const appId = account.config.clientId;
      if (appId) {
        runtime.log?.(`dingtalk:${appId}`);
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, log, setStatus, abortSignal, cfg, runtime } = ctx;
      const { clientId, clientSecret } = account.config;
      if (!clientId || !clientSecret) {
        throw new Error("DingTalk app key/secret not configured");
      }

      log?.info(`[${account.accountId}] starting DingTalk provider`);
      setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      try {
        await monitorDingTalkProvider({
          accountId: account.accountId,
          config: cfg,
          runtime,
          abortSignal,
          onConnected: () => {
            setStatus({
              accountId: account.accountId,
              connected: true,
              running: true,
              lastError: null,
            });
          },
          onDisconnected: () => {
            setStatus({
              accountId: account.accountId,
              connected: false,
            });
          },
          onInbound: () => {
            setStatus({
              accountId: account.accountId,
              lastInboundAt: Date.now(),
              connected: true,
              running: true,
            });
          },
        });
      } catch (err) {
        setStatus({
          accountId: account.accountId,
          running: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  },
};
