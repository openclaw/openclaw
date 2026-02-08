import {
  getChatChannelMeta,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { getWebexRuntime } from "./runtime.js";
import { probeWebex } from "./probe.js";
import { sendWebexMessage } from "./send.js";
import { monitorWebexProvider } from "./monitor.js";
import type { ResolvedWebexAccount, WebexConfig, WebexAccountConfig } from "./types.js";

const meta = getChatChannelMeta("webex");

function resolveWebexAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedWebexAccount {
  const { cfg, accountId } = params;
  const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
  
  const webexConfig = cfg.channels?.webex as WebexConfig | undefined;
  if (!webexConfig) {
    return {
      accountId: resolvedAccountId,
      enabled: false,
      token: "",
      tokenSource: "none",
      config: {},
    };
  }
  
  let accountConfig: WebexAccountConfig;
  let token = "";
  let tokenSource: "config" | "file" | "env" | "none" = "none";
  let name: string | undefined;
  
  // Get account-specific config or fall back to main config
  if (resolvedAccountId !== DEFAULT_ACCOUNT_ID && webexConfig.accounts?.[resolvedAccountId]) {
    accountConfig = webexConfig.accounts[resolvedAccountId];
    name = accountConfig.name;
  } else {
    accountConfig = webexConfig;
    name = webexConfig.name;
  }
  
  // Resolve token
  if (accountConfig.botToken) {
    token = accountConfig.botToken;
    tokenSource = "config";
  } else if (accountConfig.tokenFile) {
    try {
      const fs = require("fs");
      token = fs.readFileSync(accountConfig.tokenFile, "utf-8").trim();
      tokenSource = "file";
    } catch (err) {
      // File read failed, keep token empty
    }
  } else if (resolvedAccountId === DEFAULT_ACCOUNT_ID && process.env.WEBEX_BOT_TOKEN) {
    token = process.env.WEBEX_BOT_TOKEN.trim();
    tokenSource = "env";
  }
  
  return {
    accountId: resolvedAccountId,
    enabled: accountConfig.enabled ?? webexConfig.enabled ?? false,
    token,
    tokenSource,
    config: accountConfig,
    name,
  };
}

function listWebexAccountIds(cfg: OpenClawConfig): string[] {
  const webexConfig = cfg.channels?.webex as WebexConfig | undefined;
  if (!webexConfig) {
    return [];
  }
  
  const accountIds = new Set<string>([DEFAULT_ACCOUNT_ID]);
  
  if (webexConfig.accounts) {
    for (const accountId of Object.keys(webexConfig.accounts)) {
      accountIds.add(accountId);
    }
  }
  
  return Array.from(accountIds);
}

function normalizeWebexTarget(target: string): string {
  // Remove webex: prefix if present
  return target.replace(/^webex:/i, "").trim();
}

function looksLikeWebexTargetId(target: string): boolean {
  const normalized = normalizeWebexTarget(target);
  
  // Email address
  if (normalized.includes("@") && normalized.includes(".")) {
    return true;
  }
  
  // Webex person/room IDs start with base64-encoded Cisco Spark URIs
  if (normalized.startsWith("Y2lzY29zcGFyazovL3VzL")) {
    return true;
  }
  
  return false;
}

export const webexPlugin: ChannelPlugin<ResolvedWebexAccount> = {
  id: "webex",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "webexEmail",
    normalizeAllowEntry: (entry) => entry.replace(/^webex:/i, "").toLowerCase(),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWebexAccount({ cfg });
      if (!account.token) {
        throw new Error("Webex token not configured");
      }
      
      await sendWebexMessage(id, "✅ You are now authorized to send messages to this bot.", {
        accountId: account.accountId,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.webex"] },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      botToken: { type: "string" },
      tokenFile: { type: "string" },
      webhookUrl: { type: "string" },
      webhookPath: { type: "string" },
      webhookSecret: { type: "string" },
      dmPolicy: { 
        type: "string", 
        enum: ["pairing", "open", "disabled"] 
      },
      allowFrom: { 
        type: "array", 
        items: { type: "string" } 
      },
      name: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            botToken: { type: "string" },
            tokenFile: { type: "string" },
            webhookUrl: { type: "string" },
            webhookPath: { type: "string" },
            webhookSecret: { type: "string" },
            dmPolicy: { 
              type: "string", 
              enum: ["pairing", "open", "disabled"] 
            },
            allowFrom: { 
              type: "array", 
              items: { type: "string" } 
            },
            name: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
  },
  config: {
    listAccountIds: listWebexAccountIds,
    resolveAccount: (cfg, accountId) => resolveWebexAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const nextCfg = { ...cfg };
      const webexConfig = nextCfg.channels?.webex as WebexConfig | undefined;
      
      if (!webexConfig) {
        return nextCfg;
      }
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        nextCfg.channels = {
          ...nextCfg.channels,
          webex: { ...webexConfig, enabled },
        };
      } else {
        const accounts = { ...webexConfig.accounts };
        accounts[accountId] = { ...accounts[accountId], enabled };
        nextCfg.channels = {
          ...nextCfg.channels,
          webex: { ...webexConfig, accounts },
        };
      }
      
      return nextCfg;
    },
    deleteAccount: ({ cfg, accountId }) => {
      const nextCfg = { ...cfg };
      const webexConfig = nextCfg.channels?.webex as WebexConfig | undefined;
      
      if (!webexConfig) {
        return nextCfg;
      }
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { botToken, tokenFile, name, ...rest } = webexConfig;
        nextCfg.channels = { ...nextCfg.channels, webex: rest };
      } else {
        const accounts = { ...webexConfig.accounts };
        delete accounts[accountId];
        nextCfg.channels = {
          ...nextCfg.channels,
          webex: { ...webexConfig, accounts },
        };
      }
      
      return nextCfg;
    },
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWebexAccount({ cfg, accountId });
      return (account.config.allowFrom ?? []).map(String);
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^webex:/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: `channels.webex.dmPolicy`,
      allowFromPath: `channels.webex.allowFrom`,
      approveHint: "Add the user's email to channels.webex.allowFrom",
      normalizeEntry: (raw) => raw.replace(/^webex:/i, "").toLowerCase(),
    }),
    collectWarnings: () => [],
  },
  messaging: {
    normalizeTarget: normalizeWebexTarget,
    targetResolver: {
      looksLikeId: looksLikeWebexTargetId,
      hint: "<email|personId|roomId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => {
      // Simple text chunking for Webex (7439 char limit for text)
      const chunks = [];
      for (let i = 0; i < text.length; i += limit) {
        chunks.push(text.slice(i, i + limit));
      }
      return chunks;
    },
    chunkerMode: "markdown",
    textChunkLimit: 7000, // Conservative limit for Webex
    sendText: async ({ to, text, accountId }) => {
      const result = await sendWebexMessage(to, text, {
        accountId,
        markdown: text, // Enable markdown support
      });
      
      return { 
        channel: "webex", 
        ok: result.ok,
        messageId: result.messageId,
        error: result.error,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const result = await sendWebexMessage(to, text || "", {
        accountId,
        files: mediaUrl ? [mediaUrl] : undefined,
        markdown: text,
      });
      
      return { 
        channel: "webex", 
        ok: result.ok,
        messageId: result.messageId,
        error: result.error,
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
    collectStatusIssues: ({ account }) => {
      const issues = [];
      
      if (!account) {
        issues.push("webex: account not configured");
        return issues;
      }
      
      if (!account.token) {
        issues.push(`${account.accountId}: no token configured`);
      }
      
      if (!account.config?.webhookUrl) {
        issues.push(`${account.accountId}: webhookUrl not configured`);
      }
      
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
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
      await probeWebex(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      webhookUrl: account.config.webhookUrl,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg, runtime, abortSignal } = ctx;
      
      if (!account.token) {
        throw new Error("Webex token not configured");
      }
      
      if (!account.config.webhookUrl) {
        throw new Error("webhookUrl not configured. Set channels.webex.webhookUrl to your public gateway URL (e.g., via ngrok or Tailscale)");
      }
      
      ctx.log?.info(`[${account.accountId}] starting Webex provider`);
      
      return monitorWebexProvider({
        account,
        config: cfg,
        runtime: ctx.runtime,
        abortSignal,
        statusSink: ctx.statusSink,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg };
      const webexConfig = nextCfg.channels?.webex as WebexConfig | undefined;
      
      if (!webexConfig) {
        return { cleared: false, envToken: false, loggedOut: true };
      }
      
      let cleared = false;
      let changed = false;
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (webexConfig.botToken) {
          const nextWebex = { ...webexConfig };
          delete nextWebex.botToken;
          nextCfg.channels = { ...nextCfg.channels, webex: nextWebex };
          cleared = true;
          changed = true;
        }
      } else {
        const accounts = { ...webexConfig.accounts };
        if (accounts[accountId]?.botToken) {
          const nextAccount = { ...accounts[accountId] };
          delete nextAccount.botToken;
          accounts[accountId] = nextAccount;
          nextCfg.channels = {
            ...nextCfg.channels,
            webex: { ...webexConfig, accounts },
          };
          cleared = true;
          changed = true;
        }
      }
      
      if (changed) {
        await getWebexRuntime().config.writeConfigFile(nextCfg);
      }
      
      const envToken = Boolean(process.env.WEBEX_BOT_TOKEN?.trim());
      const resolvedAccount = resolveWebexAccount({ cfg: nextCfg, accountId });
      const loggedOut = resolvedAccount.tokenSource === "none";
      
      return { cleared, envToken, loggedOut };
    },
  },
};