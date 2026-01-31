/**
 * Cursor Agent channel plugin for OpenClaw.
 *
 * This plugin integrates Cursor's Background Agents API as a channel,
 * allowing OpenClaw to send coding tasks to Cursor Agent and receive results.
 *
 * Features:
 * - Send coding tasks to Cursor Background Agents
 * - Receive results via webhooks
 * - Route responses back to OpenClaw sessions
 * - Support for repository/branch specification in messages
 *
 * Usage:
 *   "Fix the bug in src/utils.ts @repo:https://github.com/user/repo @branch:main"
 */

import type {
  OpenClawConfig,
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelPlugin,
} from "openclaw/plugin-sdk";
import { cursorAgentConfigSchema } from "./config-schema.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAccountConfig,
  listAccountIds,
  isAccountConfigured,
} from "./config.js";
import { cursorAgentOutbound } from "./outbound.js";
import { cursorAgentOnboardingAdapter } from "./onboarding.js";
import { listAgents } from "./api.js";
import type { CursorAgentAccountConfig } from "./types.js";

/**
 * Cursor Agent channel plugin.
 */
export const cursorAgentPlugin: ChannelPlugin<CursorAgentAccountConfig> = {
  id: "cursor-agent",

  meta: {
    id: "cursor-agent",
    label: "Cursor Agent",
    selectionLabel: "Cursor Agent (Background API)",
    docsPath: "/channels/cursor-agent",
    blurb: "Integrate Cursor's AI coding agent for automated code tasks",
    aliases: ["cursor"],
  } satisfies ChannelMeta,

  onboarding: cursorAgentOnboardingAdapter,

  capabilities: {
    chatTypes: ["dm"], // Cursor Agent is typically used for direct tasks
  } satisfies ChannelCapabilities,

  configSchema: cursorAgentConfigSchema,

  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => listAccountIds(cfg),

    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): CursorAgentAccountConfig => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      if (!account) {
        return {
          apiKey: "",
          enabled: false,
        } as CursorAgentAccountConfig;
      }
      return account;
    },

    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    isConfigured: (_account: unknown, cfg: OpenClawConfig): boolean => {
      const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
      return account ? isAccountConfigured(account) : false;
    },

    isEnabled: (account: CursorAgentAccountConfig | undefined): boolean =>
      account?.enabled !== false,

    describeAccount: (account: CursorAgentAccountConfig | undefined) => {
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: account?.enabled !== false,
        configured: account ? isAccountConfigured(account) : false,
      };
    },
  },

  outbound: cursorAgentOutbound,

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    buildChannelSummary: ({ snapshot }: { snapshot: ChannelAccountSnapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),

    probeAccount: async ({
      account,
      timeoutMs,
    }: {
      account: CursorAgentAccountConfig;
      timeoutMs: number;
    }): Promise<unknown> => {
      // Probe by listing agents (validates API key)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const agents = await listAgents(account);
        return {
          ok: true,
          agentCount: agents.length,
          message: `Connected (${agents.length} agents)`,
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error),
        };
      } finally {
        clearTimeout(timeout);
      }
    },

    buildAccountSnapshot: ({
      account,
      runtime,
      probe,
    }: {
      account: CursorAgentAccountConfig;
      runtime?: ChannelAccountSnapshot;
      probe?: unknown;
    }): ChannelAccountSnapshot => {
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: account?.enabled !== false,
        configured: isAccountConfigured(account),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
    },
  },

  gateway: {
    startAccount: async (ctx): Promise<void> => {
      const account = ctx.account;
      const accountId = ctx.accountId;

      ctx.setStatus?.({
        accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      ctx.log?.info(`Starting Cursor Agent connection for account ${accountId}`);

      // Lazy import to avoid ESM init cycles
      const { monitorCursorAgentProvider } = await import("./monitor.js");
      await monitorCursorAgentProvider({
        account,
        accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },

    stopAccount: async (ctx): Promise<void> => {
      const accountId = ctx.accountId;

      ctx.setStatus?.({
        accountId,
        running: false,
        lastStopAt: Date.now(),
      });

      ctx.log?.info(`Stopped Cursor Agent connection for account ${accountId}`);
    },
  },
};
