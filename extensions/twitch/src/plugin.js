import { buildChannelConfigSchema } from "openclaw/plugin-sdk/twitch";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { twitchMessageActions } from "./actions.js";
import { removeClientManager } from "./client-manager-registry.js";
import { TwitchConfigSchema } from "./config-schema.js";
import { DEFAULT_ACCOUNT_ID, getAccountConfig, listAccountIds } from "./config.js";
import { twitchOnboardingAdapter } from "./onboarding.js";
import { twitchOutbound } from "./outbound.js";
import { probeTwitch } from "./probe.js";
import { resolveTwitchTargets } from "./resolver.js";
import { collectTwitchStatusIssues } from "./status.js";
import { resolveTwitchToken } from "./token.js";
import { isAccountConfigured } from "./utils/twitch.js";
const twitchPlugin = {
  /** Plugin identifier */
  id: "twitch",
  /** Plugin metadata */
  meta: {
    id: "twitch",
    label: "Twitch",
    selectionLabel: "Twitch (Chat)",
    docsPath: "/channels/twitch",
    blurb: "Twitch chat integration",
    aliases: ["twitch-chat"]
  },
  /** Onboarding adapter */
  onboarding: twitchOnboardingAdapter,
  /** Pairing configuration */
  pairing: {
    idLabel: "twitchUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(twitch:)?user:?/i, ""),
    notifyApproval: async ({ id }) => {
      console.warn(`Pairing approved for user ${id} (notification sent via chat if possible)`);
    }
  },
  /** Supported chat capabilities */
  capabilities: {
    chatTypes: ["group"]
  },
  /** Configuration schema for Twitch channel */
  configSchema: buildChannelConfigSchema(TwitchConfigSchema),
  /** Account configuration management */
  config: {
    /** List all configured account IDs */
    listAccountIds: (cfg) => listAccountIds(cfg),
    /** Resolve an account config by ID */
    resolveAccount: (cfg, accountId) => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      if (!account) {
        return {
          username: "",
          accessToken: "",
          clientId: "",
          enabled: false
        };
      }
      return account;
    },
    /** Get the default account ID */
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    /** Check if an account is configured */
    isConfigured: (_account, cfg) => {
      const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
      const tokenResolution = resolveTwitchToken(cfg, { accountId: DEFAULT_ACCOUNT_ID });
      return account ? isAccountConfigured(account, tokenResolution.token) : false;
    },
    /** Check if an account is enabled */
    isEnabled: (account) => account?.enabled !== false,
    /** Describe account status */
    describeAccount: (account) => {
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: account?.enabled !== false,
        configured: account ? isAccountConfigured(account, account?.accessToken) : false
      };
    }
  },
  /** Outbound message adapter */
  outbound: twitchOutbound,
  /** Message actions adapter */
  actions: twitchMessageActions,
  /** Resolver adapter for username -> user ID resolution */
  resolver: {
    resolveTargets: async ({
      cfg,
      accountId,
      inputs,
      kind,
      runtime
    }) => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      if (!account) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "account not configured"
        }));
      }
      const log = {
        info: (msg) => runtime.log(msg),
        warn: (msg) => runtime.log(msg),
        error: (msg) => runtime.error(msg),
        debug: (msg) => runtime.log(msg)
      };
      return await resolveTwitchTargets(inputs, account, kind, log);
    }
  },
  /** Status monitoring adapter */
  status: {
    /** Default runtime state */
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null
    },
    /** Build channel summary from snapshot */
    buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
    /** Probe account connection */
    probeAccount: async ({
      account,
      timeoutMs
    }) => {
      return await probeTwitch(account, timeoutMs);
    },
    /** Build account snapshot with current status */
    buildAccountSnapshot: ({
      account,
      cfg,
      runtime,
      probe
    }) => {
      const twitch = cfg.channels;
      const twitchCfg = twitch?.twitch;
      const accountMap = twitchCfg?.accounts ?? {};
      const resolvedAccountId = Object.entries(accountMap).find(([, value]) => value === account)?.[0] ?? DEFAULT_ACCOUNT_ID;
      const tokenResolution = resolveTwitchToken(cfg, { accountId: resolvedAccountId });
      return {
        accountId: resolvedAccountId,
        enabled: account?.enabled !== false,
        configured: isAccountConfigured(account, tokenResolution.token),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe
      };
    },
    /** Collect status issues for all accounts */
    collectStatusIssues: collectTwitchStatusIssues
  },
  /** Gateway adapter for connection lifecycle */
  gateway: {
    /** Start an account connection */
    startAccount: async (ctx) => {
      const account = ctx.account;
      const accountId = ctx.accountId;
      ctx.setStatus?.({
        accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null
      });
      ctx.log?.info(`Starting Twitch connection for ${account.username}`);
      const { monitorTwitchProvider } = await import("./monitor.js");
      await monitorTwitchProvider({
        account,
        accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal
      });
    },
    /** Stop an account connection */
    stopAccount: async (ctx) => {
      const account = ctx.account;
      const accountId = ctx.accountId;
      await removeClientManager(accountId);
      ctx.setStatus?.({
        accountId,
        running: false,
        lastStopAt: Date.now()
      });
      ctx.log?.info(`Stopped Twitch connection for ${account.username}`);
    }
  }
};
export {
  twitchPlugin
};
