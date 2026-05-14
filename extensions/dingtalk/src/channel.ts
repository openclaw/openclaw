import process from "node:process";
import type { ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/core";
import {
  resolveDingtalkAccount,
  resolveDingtalkCredentials,
  listDingtalkAccountIds,
  resolveDefaultDingtalkAccountId,
} from "./config/accounts.ts";
import { DingtalkConfigBaseSchema } from "./config/schema.ts";
import { monitorDingtalkProvider } from "./core/provider.ts";
import { resolveDingtalkGroupToolPolicy } from "./policy.ts";
import { probeDingtalk } from "./probe.ts";
import {
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "./sdk/helpers.ts";
import { sendTextToDingTalk, sendMediaToDingTalk } from "./services/messaging/index.ts";
import { normalizeDingtalkTarget, looksLikeDingtalkId } from "./targets.ts";
import type { ResolvedDingtalkAccount, DingtalkConfig } from "./types/index.ts";
import { createLogger } from "./utils/logger.ts";

/** Channel identifier used across the plugin. Single source of truth. */
export const CHANNEL_ID = "dingtalk" as const;

/**
 * Per-account holder for DWS credentials. Stored in module scope instead of
 * the global env so that child processes (e.g. Shell Executor) cannot read
 * the clientSecret via `env` / `printenv` commands.
 *
 * Keyed by accountId to avoid multi-account credential overwriting.
 * Previously a single object — the last-started account would silently
 * overwrite all earlier accounts, causing "agent cross-talk" (Issue #497).
 */
const dwsCredentialsByAccount = new Map<string, { clientId: string; clientSecret: string }>();

/**
 * Environment snapshot for spawning the trusted `dws` CLI only.
 *
 * Trust boundary:
 * - `DWS_CLIENT_SECRET` is never written to the gateway `process.env`.
 * - Secrets live in memory (`dwsCredentialsByAccount`) until this map is
 *   passed as `child_process` spawn `env`. Any process started with that env
 *   can read the secret (same exposure as `dws auth` with env-based credentials).
 * - Do not merge this object into arbitrary shells or unrelated subprocesses;
 *   use it only when argv is the `dws` binary (or a documented wrapper).
 */
export function getDwsSpawnEnv(accountId?: string): Record<string, string> {
  const creds = accountId
    ? dwsCredentialsByAccount.get(accountId)
    : dwsCredentialsByAccount.values().next().value;

  return {
    ...(process.env as Record<string, string>),
    DINGTALK_AGENT: "DING_DWS_CLAW",
    ...(creds?.clientId && { DWS_CLIENT_ID: creds.clientId }),
    ...(creds?.clientSecret && { DWS_CLIENT_SECRET: creds.clientSecret }),
  };
}

const meta = {
  id: CHANNEL_ID,
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  docsPath: `/channels/${CHANNEL_ID}`,
  docsLabel: CHANNEL_ID,
  blurb:
    "DingTalk enterprise bot using Stream mode (no public IP required) with AI Card streaming responses.",
  aliases: ["dd", "ding"] as string[],
  order: 70,
};

export const dingtalkPlugin: ChannelPlugin<ResolvedDingtalkAccount> = {
  id: CHANNEL_ID,
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "dingtalkUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(dingtalk|user|dd):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      // TODO: Implement notification when pairing is approved
      const logger = createLogger(false, "DingTalk:Pairing");
      logger.info(`Pairing approved for user: ${id}`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: true, // ✅ 启用媒体支持
    reactions: false,
    edit: false,
    reply: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- DingTalk targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:userId` or `group:conversationId`.",
      "- DingTalk supports interactive cards for rich messages.",
    ],
  },
  groups: {
    resolveToolPolicy: resolveDingtalkGroupToolPolicy,
  },
  mentions: {
    stripPatterns: () => ["@[^\\s]+"], // Strip @mentions
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: buildChannelConfigSchema(DingtalkConfigBaseSchema),
  config: {
    listAccountIds: (cfg) => listDingtalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDingtalkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDingtalkAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const account = resolveDingtalkAccount({ cfg, accountId });
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // For default account, set top-level enabled
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [CHANNEL_ID]: {
              ...cfg.channels?.[CHANNEL_ID],
              enabled,
            },
          },
        };
      }

      // For named accounts, set enabled in accounts[accountId]
      const dingtalkCfg = cfg.channels?.[CHANNEL_ID] as DingtalkConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...dingtalkCfg,
            accounts: {
              ...dingtalkCfg?.accounts,
              [accountId]: {
                ...dingtalkCfg?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // Delete entire dingtalk config
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>)[CHANNEL_ID];
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      // Delete specific account from accounts
      const dingtalkCfg = cfg.channels?.[CHANNEL_ID] as DingtalkConfig | undefined;
      const accounts = { ...dingtalkCfg?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...dingtalkCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      clientId: account.clientId,
    }),
    // 返回空列表，禁止框架层对发送者做全局过滤。
    // 连接器内部（message-handler.ts）已按 dmPolicy/groupPolicy 各自独立检查，
    // allowFrom 仅用于私聊，groupAllowFrom 仅用于群聊，不应被框架层全局应用。
    resolveAllowFrom: () => [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveDingtalkAccount({ cfg, accountId });
      const dingtalkCfg = account.config;
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.[CHANNEL_ID] !== undefined,
        groupPolicy: dingtalkCfg?.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") return [];
      return [
        `- DingTalk[${account.accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.${CHANNEL_ID}.groupPolicy="allowlist" + channels.${CHANNEL_ID}.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [CHANNEL_ID]: {
              ...cfg.channels?.[CHANNEL_ID],
              enabled: true,
            },
          },
        };
      }

      const dingtalkCfg = cfg.channels?.[CHANNEL_ID] as DingtalkConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...dingtalkCfg,
            accounts: {
              ...dingtalkCfg?.accounts,
              [accountId]: {
                ...dingtalkCfg?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeDingtalkTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeDingtalkId,
      hint: "<userId|user:userId|group:conversationId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => {
      // Simple markdown chunking - split by newlines
      const chunks: string[] = [];
      const lines = text.split("\n");
      let currentChunk = "";

      for (const line of lines) {
        const testChunk = currentChunk + (currentChunk ? "\n" : "") + line;
        if (testChunk.length <= limit) {
          currentChunk = testChunk;
        } else {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = line;
        }
      }
      if (currentChunk) chunks.push(currentChunk);

      return chunks;
    },
    chunkerMode: "markdown",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const account = resolveDingtalkAccount({ cfg, accountId });
      // 使用已解析的凭据覆盖原始 config，防止 clientId/clientSecret 为 SecretInput 对象或 undefined
      const resolvedConfig: DingtalkConfig = {
        ...account.config,
        ...(account.clientId != null ? { clientId: account.clientId } : {}),
        ...(account.clientSecret != null ? { clientSecret: account.clientSecret } : {}),
      };
      const result = await sendTextToDingTalk({
        config: resolvedConfig,
        target: to,
        text,
        replyToId,
      });
      return {
        channel: CHANNEL_ID,
        messageId: result.processQueryKey ?? result.cardInstanceId ?? "unknown",
        conversationId: to,
      };
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      accountId,
      mediaLocalRoots,
      replyToId,
      threadId,
    }) => {
      const account = resolveDingtalkAccount({ cfg, accountId });
      // 使用已解析的凭据覆盖原始 config，防止 clientId/clientSecret 为 SecretInput 对象或 undefined
      const resolvedConfig: DingtalkConfig = {
        ...account.config,
        ...(account.clientId != null ? { clientId: account.clientId } : {}),
        ...(account.clientSecret != null ? { clientSecret: account.clientSecret } : {}),
      };
      const logger = createLogger(account.config?.debug ?? false, "DingTalk:SendMedia");

      logger.info(
        "开始处理，参数:",
        JSON.stringify({
          to,
          text,
          mediaUrl,
          accountId,
          replyToId,
          threadId,
          toType: typeof to,
          mediaUrlType: typeof mediaUrl,
        }),
      );

      // 参数校验
      if (!to || typeof to !== "string") {
        throw new Error(`Invalid 'to' parameter: ${to}`);
      }

      if (!mediaUrl || typeof mediaUrl !== "string") {
        throw new Error(`Invalid 'mediaUrl' parameter: ${mediaUrl}`);
      }

      const result = await sendMediaToDingTalk({
        config: resolvedConfig,
        target: to,
        text,
        mediaUrl,
        replyToId,
        mediaLocalRoots,
      });

      logger.info(
        "sendMediaToDingTalk 返回结果:",
        JSON.stringify({
          ok: result.ok,
          error: result.error,
          hasProcessQueryKey: !!result.processQueryKey,
          hasCardInstanceId: !!result.cardInstanceId,
        }),
      );

      return {
        channel: CHANNEL_ID,
        messageId: result.processQueryKey ?? result.cardInstanceId ?? "unknown",
        conversationId: to,
      };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }) as any,
    buildChannelSummary: ({ snapshot }) => ({
      // 只返回 probe 相关字段，不透传运行时字段（running/lastStartAt 等）。
      // 运行时状态由框架从 store.runtimes 自动维护，buildChannelSummary 在 probe
      // 流程中被调用时 runtime 为 undefined，透传会导致 lastStartAt 永远是 null。
      configured: snapshot.configured ?? false,
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) =>
      await probeDingtalk({
        clientId: account.clientId!,
        clientSecret: account.clientSecret!,
        accountId: account.accountId,
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      clientId: account.clientId,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
      // 连接状态和消息时间戳：由 startAccount 里的 onStatusChange 回调写入 runtime，
      // 必须在此处透传，否则 UI 的 Connected 和 Last inbound 字段永远显示 n/a。
      connected: runtime?.connected ?? null,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveDingtalkAccount({ cfg: ctx.cfg, accountId: ctx.accountId });

      // 检查账号是否启用和配置
      if (!account.enabled) {
        ctx.log?.info?.(`dingtalk[${ctx.accountId}] is disabled, skipping startup`);
        // 返回一个永不 resolve 的 Promise，保持 pending 状态直到 abort
        return new Promise<void>((resolve) => {
          if (ctx.abortSignal?.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }

      if (!account.configured) {
        throw new Error(`DingTalk account "${ctx.accountId}" is not properly configured`);
      }

      // 去重检查：如果列表中排在当前账号之前的账号已使用相同 clientId，则跳过当前账号
      // 使用静态配置分析（而非运行时状态），避免并发竞态条件
      // 规则：同一 clientId 只有列表中第一个启用且已配置的账号才会建立连接
      if (account.clientId) {
        const clientId = String(account.clientId);
        const allAccountIds = listDingtalkAccountIds(ctx.cfg);
        const currentIndex = allAccountIds.indexOf(ctx.accountId);
        const priorAccountWithSameClientId = allAccountIds
          .slice(0, currentIndex)
          .find((otherId) => {
            const other = resolveDingtalkAccount({ cfg: ctx.cfg, accountId: otherId });
            return (
              other.enabled &&
              other.configured &&
              other.clientId &&
              String(other.clientId) === clientId
            );
          });
        if (priorAccountWithSameClientId) {
          ctx.log?.info?.(
            `dingtalk[${ctx.accountId}] skipped: clientId "${clientId.substring(0, 8)}..." is already used by account "${priorAccountWithSameClientId}"`,
          );
          return new Promise<void>((resolve) => {
            if (ctx.abortSignal?.aborted) {
              resolve();
              return;
            }
            ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      }

      // Set DINGTALK_AGENT to identify the calling context (non-sensitive).
      // App secret stays off global env; see `getDwsSpawnEnv` for dws-only spawn env.
      process.env.DINGTALK_AGENT = "DING_DWS_CLAW";
      if (account.clientId && account.clientSecret) {
        dwsCredentialsByAccount.set(ctx.accountId, {
          clientId: String(account.clientId),
          clientSecret: String(account.clientSecret),
        });
        // Expose clientId (non-sensitive) in process.env so that AI agents
        // can read it via `echo $DWS_CLIENT_ID` and inject `--client-id`
        // into dws CLI commands for correct bot identity isolation.
        // Note: in multi-bot setups the last-started bot's clientId wins,
        // but the skill prompt instructs the AI to always read & pass it.
        process.env.DWS_CLIENT_ID = String(account.clientId);
      }

      ctx.setStatus({ accountId: ctx.accountId, port: null });
      ctx.log?.info(
        `starting dingtalk[${ctx.accountId}] (mode: stream, DINGTALK_AGENT=DING_DWS_CLAW, DWS_CLIENT_ID=${account.clientId ? String(account.clientId).substring(0, 8) + "..." : "N/A"})`,
      );

      // 把 ctx.setStatus 包装成 onStatusChange 回调，传入连接层，
      // 使连接层能在 WebSocket 连接/断开/收到消息时更新 UI 显示的
      // Connected 和 Last inbound 字段。
      // 注意：ctx.setStatus 是完全替换而非 merge patch，必须先 getStatus()
      // 获取当前快照再合并，否则会清空 configured/running 等已有字段。
      const onStatusChange = (patch: Record<string, unknown>) => {
        const currentSnapshot = ctx.getStatus?.() ?? { accountId: ctx.accountId };
        const nextSnapshot = { ...currentSnapshot, ...patch, accountId: ctx.accountId };
        process.stderr.write(
          `[dingtalk][${ctx.accountId}] onStatusChange patch=${JSON.stringify(patch)} current=${JSON.stringify(currentSnapshot)} next=${JSON.stringify(nextSnapshot)}\n`,
        );
        ctx.setStatus(nextSnapshot as any);
      };

      try {
        return await monitorDingtalkProvider({
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          accountId: ctx.accountId,
          onStatusChange,
        });
      } catch (err: any) {
        // 打印真实错误到 stderr，绕过框架 log 系统（框架的 runtime.log 可能未初始化）
        ctx.log?.error(
          `[dingtalk][${ctx.accountId}] startAccount error: ${err?.message ?? err}\n${err?.stack ?? ""}`,
        );
        throw err;
      }
    },
  },
};

/**
 * Backwards-compatible no-op kept so older entrypoints can still call it.
 * The schema is now built statically when this module is imported via
 * `buildChannelConfigSchema(DingtalkConfigBaseSchema)`.
 */
export function initDingtalkPluginConfigSchema(): void {
  // configSchema is initialized statically above; nothing to do here.
}
