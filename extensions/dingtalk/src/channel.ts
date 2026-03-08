/**
 * DingTalk ChannelPlugin implementation
 *
 * Implements Moltbot ChannelPlugin interface, provides:
 * - meta: channel metadata
 * - capabilities: channel capability declaration
 * - config: account config adapter
 * - outbound: outbound message adapter
 * - gateway: connection management adapter
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/dingtalk";
import { DingtalkConfigSchema, isConfigured, resolveDingtalkCredentials } from "./config.js";
import {
  listDingtalkDirectoryPeers,
  listDingtalkDirectoryPeersLive,
  listDingtalkDirectoryGroups,
} from "./directory.js";
import { monitorDingtalkProvider } from "./monitor.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";
import { dingtalkOutbound } from "./outbound.js";
import { resolveDingtalkTargets } from "./resolver.js";
import { setDingtalkRuntime } from "./runtime.js";
import type { ResolvedDingtalkAccount, DingtalkConfig } from "./types.js";

/** Default account ID */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Channel metadata
 */
const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "DingTalk enterprise messaging",
  aliases: ["ding"] as string[],
  order: 71,
} as const;

/**
 * Resolve DingTalk account config
 *
 * @param params Parameter object
 * @returns Resolved account config
 */
function resolveDingtalkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDingtalkAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;

  // Parse config
  const parsed = dingtalkCfg ? DingtalkConfigSchema.safeParse(dingtalkCfg) : null;
  const config = parsed?.success ? parsed.data : undefined;

  // Check if credentials are configured
  const credentials = resolveDingtalkCredentials(config);
  const configured = Boolean(credentials);

  return {
    accountId,
    enabled: config?.enabled ?? true,
    configured,
    clientId: credentials?.clientId,
  };
}

/**
 * DingTalk channel plugin
 *
 * Implements ChannelPlugin interface, provides complete DingTalk messaging channel functionality
 */
export const dingtalkPlugin: ChannelPlugin<ResolvedDingtalkAccount> = {
  id: "dingtalk",

  /**
   * Channel metadata
   * Requirements: 1.2
   */
  meta,

  /**
   * Channel capability declaration
   * Requirements: 1.3
   */
  capabilities: {
    chatTypes: ["direct", "channel"] as ("direct" | "group" | "channel" | "thread")[],
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    blockStreaming: true,
  },

  /**
   * Config Schema
   * Requirements: 1.4
   */
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        requireMention: { type: "boolean" },
        allowFrom: { type: "array", items: { type: "string" } },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        historyLimit: { type: "integer", minimum: 0 },
        textChunkLimit: { type: "integer", minimum: 1 },
        enableAICard: { type: "boolean" },
        gatewayToken: { type: "string" },
        gatewayPassword: { type: "string" },
        // Async task configuration
        asyncMode: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", description: "Enable smart async task mode" },
            slowTaskThresholdMs: {
              type: "integer",
              minimum: 1000,
              description:
                "Slow task threshold (milliseconds), tasks exceeding this time will be considered slow tasks",
            },
            maxConcurrency: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "Maximum concurrency",
            },
            autoAsyncKeywords: {
              type: "array",
              items: { type: "string" },
              description: "Auto async execution keyword list",
            },
            statusQueryKeywords: {
              type: "array",
              items: { type: "string" },
              description: "Status query keyword list",
            },
            cancelTaskKeywords: {
              type: "array",
              items: { type: "string" },
              description: "Cancel task keyword list",
            },
          },
        },
      },
    },
  },

  /**
   * Config reload trigger
   */
  reload: { configPrefixes: ["channels.dingtalk"] },

  /**
   * Account config adapter
   * Requirements: 2.1, 2.2, 2.3
   */
  config: {
    /**
     * List all account IDs
     * Requirements: 2.1
     */
    listAccountIds: (_cfg: OpenClawConfig): string[] => [DEFAULT_ACCOUNT_ID],

    /**
     * Resolve account config
     * Requirements: 2.2
     */
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedDingtalkAccount =>
      resolveDingtalkAccount({ cfg, accountId: accountId ?? undefined }),

    /**
     * Get default account ID
     */
    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    /**
     * Set account enabled status
     */
    setAccountEnabled: (params: { cfg: OpenClawConfig; enabled: boolean }): OpenClawConfig => {
      const existingConfig = params.cfg.channels?.dingtalk ?? {};
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          dingtalk: {
            ...existingConfig,
            enabled: params.enabled,
          } as DingtalkConfig,
        },
      } as OpenClawConfig;
    },

    /**
     * Delete account config
     */
    deleteAccount: (params: { cfg: OpenClawConfig }): OpenClawConfig => {
      const next = { ...params.cfg };
      const nextChannels = { ...params.cfg.channels };
      delete (nextChannels as Record<string, unknown>).dingtalk;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels as typeof params.cfg.channels;
      } else {
        delete next.channels;
      }
      return next;
    },

    /**
     * Check if account is configured
     * Requirements: 2.3
     */
    isConfigured: (_account: ResolvedDingtalkAccount, cfg: OpenClawConfig): boolean =>
      isConfigured(cfg.channels?.dingtalk as DingtalkConfig | undefined),

    /**
     * Describe account info
     */
    describeAccount: (account: ResolvedDingtalkAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),

    /**
     * Resolve allowlist
     */
    resolveAllowFrom: (params: { cfg: OpenClawConfig }): string[] =>
      (params.cfg.channels?.dingtalk as DingtalkConfig | undefined)?.allowFrom ?? [],

    /**
     * Format allowlist entries
     */
    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  /**
   * Security warning collector
   */
  security: {
    collectWarnings: (params: { cfg: OpenClawConfig }): string[] => {
      const dingtalkCfg = params.cfg.channels?.dingtalk as DingtalkConfig | undefined;
      const groupPolicy = dingtalkCfg?.groupPolicy ?? "open";
      if (groupPolicy !== "open") return [];
      return [
        `- DingTalk groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.dingtalk.groupPolicy="allowlist" + channels.dingtalk.groupAllowFrom to restrict senders.`,
      ];
    },
  },

  /**
   * Setup wizard adapter
   */
  setup: {
    resolveAccountId: (): string => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: (params: { cfg: OpenClawConfig }): OpenClawConfig => {
      const existingConfig = params.cfg.channels?.dingtalk ?? {};
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          dingtalk: {
            ...existingConfig,
            enabled: true,
          } as DingtalkConfig,
        },
      } as OpenClawConfig;
    },
  },

  /**
   * Target resolution adapter
   * Resolves username/nickname to DingTalk userId
   */
  resolver: {
    resolveTargets: resolveDingtalkTargets,
  },

  /**
   * Onboarding adapter
   */
  onboarding: dingtalkOnboardingAdapter,

  /**
   * Directory adapter
   * Used by target-resolver to resolve username to userId
   */
  directory: {
    self: async () => null,
    listPeers: async (params: {
      cfg: OpenClawConfig;
      query?: string | null;
      limit?: number | null;
      accountId?: string | null;
    }) =>
      listDingtalkDirectoryPeers({
        cfg: params.cfg,
        query: params.query ?? undefined,
        limit: params.limit ?? undefined,
        accountId: params.accountId ?? undefined,
      }),
    listGroups: async (params: {
      cfg: OpenClawConfig;
      query?: string | null;
      limit?: number | null;
      accountId?: string | null;
    }) =>
      listDingtalkDirectoryGroups({
        cfg: params.cfg,
        query: params.query ?? undefined,
        limit: params.limit ?? undefined,
        accountId: params.accountId ?? undefined,
      }),
    listPeersLive: async (params: {
      cfg: OpenClawConfig;
      query?: string | null;
      limit?: number | null;
      accountId?: string | null;
    }) =>
      listDingtalkDirectoryPeersLive({
        cfg: params.cfg,
        query: params.query ?? undefined,
        limit: params.limit ?? undefined,
        accountId: params.accountId ?? undefined,
      }),
  },

  /**
   * Outbound message adapter
   * Requirements: 7.1, 7.6
   */
  outbound: dingtalkOutbound,

  /**
   * Gateway connection management adapter
   * Requirements: 3.1
   */
  gateway: {
    /**
     * Start account connection
     * Requirements: 3.1
     */
    startAccount: async (ctx) => {
      ctx.setStatus({ accountId: ctx.accountId } as { accountId: string });
      ctx.log?.info(`[dingtalk] starting provider for account ${ctx.accountId}`);

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: { dispatchReplyFromConfig?: unknown };
          };
        };
        if (
          candidate.channel?.routing?.resolveAgentRoute &&
          candidate.channel?.reply?.dispatchReplyFromConfig
        ) {
          setDingtalkRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      return monitorDingtalkProvider({
        config: { channels: { dingtalk: ctx.cfg.channels?.dingtalk } },
        runtime: (ctx.runtime as {
          log?: (msg: string) => void;
          error?: (msg: string) => void;
        }) ?? {
          log: ctx.log?.info ?? console.log,
          error: ctx.log?.error ?? console.error,
        },
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
