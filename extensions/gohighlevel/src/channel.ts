import type {
  ChannelDock,
  ChannelPlugin,
  ChannelStatusIssue,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  missingTargetError,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
} from "openclaw/plugin-sdk";
import {
  listGoHighLevelAccountIds,
  resolveDefaultGoHighLevelAccountId,
  resolveGoHighLevelAccount,
  type ResolvedGoHighLevelAccount,
} from "./accounts.js";
import { sendGHLMessage, probeGoHighLevel } from "./api.js";
import { GoHighLevelConfigSchema } from "./config-schema.js";
import { resolveGoHighLevelWebhookPath, startGoHighLevelMonitor } from "./monitor.js";
import { gohighlevelOnboardingAdapter } from "./onboarding.js";
import { getGoHighLevelRuntime } from "./runtime.js";

const meta = {
  id: "gohighlevel",
  label: "GoHighLevel",
  selectionLabel: "GoHighLevel (CRM)",
  docsPath: "/channels/gohighlevel",
  docsLabel: "gohighlevel",
  blurb: "GoHighLevel CRM — AI chatbot for SMS, webchat, email, IG, FB, and GMB.",
  aliases: ["ghl", "highlevel"],
  order: 70,
} as const;

const formatAllowFromEntry = (entry: string) =>
  entry
    .trim()
    .replace(/^(gohighlevel|ghl|highlevel):/i, "")
    .toLowerCase();

function resolveAllowFrom(account: ResolvedGoHighLevelAccount): string[] {
  return (account.config.dm?.allowFrom ?? account.config.allowFrom ?? []).map((v) => String(v));
}

function resolveDmPolicyValue(account: ResolvedGoHighLevelAccount): string {
  return account.config.dm?.policy ?? account.config.dmPolicy ?? "open";
}

export const gohighlevelDock: ChannelDock = {
  id: "gohighlevel",
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    media: true,
    threads: false,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 1600 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveAllowFrom(resolveGoHighLevelAccount({ cfg, accountId })),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
};

export const gohighlevelPlugin: ChannelPlugin<ResolvedGoHighLevelAccount> = {
  id: "gohighlevel",
  meta: {
    ...meta,
    aliases: [...meta.aliases],
  },
  onboarding: gohighlevelOnboardingAdapter,
  pairing: {
    idLabel: "gohighlevelContactId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveGoHighLevelAccount({ cfg });
      if (account.credentialSource === "none") {
        return;
      }
      await sendGHLMessage({
        account,
        conversationId: id,
        message: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.gohighlevel"] },
  configSchema: buildChannelConfigSchema(GoHighLevelConfigSchema),
  config: {
    listAccountIds: (cfg) => listGoHighLevelAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveGoHighLevelAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultGoHighLevelAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "gohighlevel",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "gohighlevel",
        accountId,
        clearBaseFields: [
          "apiKey",
          "locationId",
          "webhookPath",
          "webhookUrl",
          "webhookSecret",
          "name",
        ],
      }),
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveAllowFrom(resolveGoHighLevelAccount({ cfg, accountId })),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveGoHighLevelAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.["gohighlevel"]?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.gohighlevel.accounts.${resolvedAccountId}.dm.`
        : "channels.gohighlevel.dm.";
      return {
        policy: resolveDmPolicyValue(account),
        allowFrom: resolveAllowFrom(account),
        allowFromPath,
        approveHint: formatPairingApproveHint("gohighlevel"),
        normalizeEntry: (raw: string) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (resolveDmPolicyValue(account) === "open") {
        warnings.push(
          `- GoHighLevel DMs are open to anyone. Set channels.gohighlevel.dm.policy="pairing" or "allowlist" for tighter control.`,
        );
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (raw) => raw?.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw.trim()),
      hint: "<contactId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoHighLevelAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const allowFromList = resolveAllowFrom(account);
      const peers = Array.from(
        new Set(
          allowFromList
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*"),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user" as const, id }));
      return peers;
    },
  },
  resolver: {
    resolveTargets: async ({ inputs }) => {
      return inputs.map((input) => {
        const normalized = input.trim();
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        return { input, resolved: true, id: normalized };
      });
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "gohighlevel",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "GHL_API_KEY env var can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "GoHighLevel requires --token (API key).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "gohighlevel",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "gohighlevel" })
          : namedConfig;
      const patch = input.useEnv ? {} : input.token ? { apiKey: input.token } : {};
      const locationId = input.audience?.trim();
      const webhookPath = input.webhookPath?.trim();
      const webhookUrl = input.webhookUrl?.trim();
      const configPatch = {
        ...patch,
        ...(locationId ? { locationId } : {}),
        ...(webhookPath ? { webhookPath } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            gohighlevel: {
              ...next.channels?.["gohighlevel"],
              enabled: true,
              ...configPatch,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          gohighlevel: {
            ...next.channels?.["gohighlevel"],
            enabled: true,
            accounts: {
              ...next.channels?.["gohighlevel"]?.accounts,
              [accountId]: {
                ...next.channels?.["gohighlevel"]?.accounts?.[accountId],
                enabled: true,
                ...configPatch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getGoHighLevelRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1600,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return { ok: false, error: missingTargetError("GoHighLevel", "<contactId>") };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveGoHighLevelAccount({ cfg, accountId });
      const result = await sendGHLMessage({
        account,
        conversationId: to,
        message: text,
      });
      return {
        channel: "gohighlevel",
        messageId: result?.messageId ?? "",
        chatId: to,
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
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) {
          return [];
        }
        const issues: ChannelStatusIssue[] = [];
        if (!entry.audience) {
          issues.push({
            channel: "gohighlevel",
            accountId,
            kind: "config",
            message: "GoHighLevel locationId is missing (set channels.gohighlevel.locationId).",
            fix: "Set channels.gohighlevel.locationId to your GHL Location ID.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      webhookPath: snapshot.webhookPath ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeGoHighLevel(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      audience: account.locationId,
      webhookPath: account.config.webhookPath,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: resolveDmPolicyValue(account),
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting GoHighLevel webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveGoHighLevelWebhookPath({ account }),
        audience: account.locationId,
      });
      const unregister = await startGoHighLevelMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      // Keep the promise pending until abort (webhook mode is passive).
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      unregister?.();
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
