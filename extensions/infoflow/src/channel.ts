import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  getChannelSection,
  listInfoflowAccountIds,
  resolveDefaultInfoflowAccountId,
  resolveInfoflowAccount,
} from "./accounts.js";
import { getInfoflowSendLog } from "./logging.js";
import { startInfoflowMonitor } from "./monitor.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowMessage } from "./send.js";
import { normalizeInfoflowTarget, looksLikeInfoflowId } from "./targets.js";
import type { InfoflowMessageContentItem, ResolvedInfoflowAccount } from "./types.js";

// Re-export types and account functions for external consumers
export type { InfoflowAccountConfig, ResolvedInfoflowAccount } from "./types.js";
export { resolveInfoflowAccount } from "./accounts.js";

// ---------------------------------------------------------------------------
// Channel plugin
// ---------------------------------------------------------------------------

export const infoflowPlugin: ChannelPlugin<ResolvedInfoflowAccount> = {
  id: "infoflow",
  meta: {
    id: "infoflow",
    label: "Infoflow",
    selectionLabel: "Infoflow (如流)",
    docsPath: "/channels/infoflow",
    blurb: "Baidu Infoflow enterprise messaging platform.",
    showConfigured: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    nativeCommands: true,
  },
  reload: { configPrefixes: ["channels.infoflow"] },
  config: {
    listAccountIds: (cfg) => listInfoflowAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveInfoflowAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultInfoflowAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "infoflow",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "infoflow",
        accountId,
        clearBaseFields: ["checkToken", "encodingAESKey", "appKey", "appSecret", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelCfg = getChannelSection(cfg);
      const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.infoflow.accounts.${resolvedAccountId}.`
        : "channels.infoflow.";

      return {
        policy: ((account.config as Record<string, unknown>).dmPolicy as string) ?? "open",
        allowFrom: ((account.config as Record<string, unknown>).allowFrom as string[]) ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("infoflow"),
        normalizeEntry: (raw: string) => raw.replace(/^infoflow:/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy =
        ((account.config as Record<string, unknown>).groupPolicy as string) ??
        defaultGroupPolicy ??
        "open";

      if (groupPolicy === "open") {
        warnings.push(
          `- Infoflow groups: groupPolicy="open" allows any group to trigger. Consider setting channels.infoflow.groupPolicy="allowlist".`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const channelCfg = getChannelSection(cfg);
      const accountCfg =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? channelCfg?.accounts?.[accountId]
          : channelCfg;
      return (accountCfg as Record<string, unknown> | undefined)?.requireMention !== false;
    },
    resolveToolPolicy: () => {
      // Return undefined to use global policy
      return undefined;
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeInfoflowTarget(raw),
    targetResolver: {
      looksLikeId: looksLikeInfoflowId,
      hint: "<username|group:groupId>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "infoflow",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token) {
        return "Infoflow requires --token (checkToken).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "infoflow",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "infoflow" })
          : namedConfig;

      const patch: Record<string, unknown> = {};
      if (input.token) {
        patch.checkToken = input.token;
      }

      const existing = (next.channels?.["infoflow"] ?? {}) as Record<string, unknown>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            infoflow: {
              ...existing,
              enabled: true,
              ...patch,
            },
          },
        } as OpenClawConfig;
      }
      const existingAccounts = (existing.accounts ?? {}) as Record<string, Record<string, unknown>>;
      return {
        ...next,
        channels: {
          ...next.channels,
          infoflow: {
            ...existing,
            enabled: true,
            accounts: {
              ...existingAccounts,
              [accountId]: {
                ...existingAccounts[accountId],
                enabled: true,
                ...patch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    chunker: (text, limit) => getInfoflowRuntime().channel.text.chunkText(text, limit),
    sendText: async ({ cfg, to, text, accountId }) => {
      const verbose = getInfoflowRuntime().logging.shouldLogVerbose();
      if (verbose) {
        getInfoflowSendLog().debug?.(`[infoflow:sendText] to=${to}, accountId=${accountId}`);
      }
      // Use "markdown" type even though param is named `text`: LLM outputs are often markdown,
      // and Infoflow's markdown type handles both plain text and markdown seamlessly.
      const result = await sendInfoflowMessage({
        cfg,
        to,
        contents: [{ type: "markdown", content: text }],
        accountId: accountId ?? undefined,
      });
      return {
        channel: "infoflow",
        messageId: result.ok ? (result.messageId ?? "sent") : "failed",
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const verbose = getInfoflowRuntime().logging.shouldLogVerbose();
      if (verbose) {
        getInfoflowSendLog().debug?.(
          `[infoflow:sendMedia] to=${to}, accountId=${accountId}, mediaUrl=${mediaUrl}`,
        );
      }

      // Build contents array: text (if provided) + link for media URL
      const contents: InfoflowMessageContentItem[] = [];
      const trimmedText = text?.trim();
      if (trimmedText) {
        // Use "markdown" type even though param is named `text`: LLM outputs are often markdown,
        // and Infoflow's markdown type handles both plain text and markdown seamlessly.
        contents.push({ type: "markdown", content: trimmedText });
      }
      if (mediaUrl) {
        contents.push({ type: "link", content: mediaUrl });
      }

      // Fallback: if no valid content, return early
      if (contents.length === 0) {
        return {
          channel: "infoflow",
          messageId: "failed",
        };
      }

      const result = await sendInfoflowMessage({
        cfg,
        to,
        contents,
        accountId: accountId ?? undefined,
      });
      return {
        channel: "infoflow",
        messageId: result.ok ? (result.messageId ?? "sent") : "failed",
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
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Infoflow webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });
      const unregister = await startInfoflowMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
