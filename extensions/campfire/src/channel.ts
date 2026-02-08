import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  resolveChannelMediaMaxBytes,
  setAccountEnabledInConfigSection,
  type ChannelDock,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listCampfireAccountIds,
  resolveDefaultCampfireAccountId,
  resolveCampfireAccount,
  type ResolvedCampfireAccount,
} from "./accounts.js";
import { sendCampfireMessage, sendCampfireAttachment, probeCampfire } from "./api.js";
import { campfireChannelConfigSchema } from "./config-schema.js";
import { resolveCampfireWebhookPath, startCampfireMonitor } from "./monitor.js";
import { getCampfireRuntime } from "./runtime.js";

const meta = {
  id: "campfire" as const,
  label: "Campfire",
  selectionLabel: "Campfire (37signals)",
  detailLabel: "Campfire",
  docsPath: "/channels/campfire",
  docsLabel: "campfire",
  blurb: "37signals self-hosted chat via bot webhooks.",
  aliases: ["once-campfire"],
  order: 60,
};

const formatAllowFromEntry = (entry: string) =>
  entry
    .trim()
    .replace(/^campfire:/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();

export const campfireDock: ChannelDock = {
  id: "campfire",
  capabilities: {
    chatTypes: ["group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveCampfireAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveCampfireAccount({ cfg, accountId });
      const groups = account.config.groups ?? {};
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? account.config.requireMention ?? true;
    },
  },
};

export const campfirePlugin: ChannelPlugin<ResolvedCampfireAccount> = {
  id: "campfire",
  meta: { ...meta },
  capabilities: {
    chatTypes: ["group"],
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.campfire"] },
  configSchema: campfireChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listCampfireAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveCampfireAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultCampfireAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "campfire",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "campfire",
        accountId,
        clearBaseFields: ["baseUrl", "botKey", "webhookPath", "name"],
      }),
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveCampfireAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channel = cfg.channels?.["campfire"] as
        | { accounts?: Record<string, unknown> }
        | undefined;
      const useAccountPath = Boolean(channel?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.campfire.accounts.${resolvedAccountId}.dm.`
        : "channels.campfire.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("campfire"),
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
      if (groupPolicy === "open") {
        warnings.push(
          `- Campfire rooms: groupPolicy="open" allows any room to trigger. Set channels.campfire.groupPolicy="allowlist" and configure channels.campfire.groups.`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveCampfireAccount({ cfg, accountId });
      const groups = account.config.groups ?? {};
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? account.config.requireMention ?? true;
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim() ?? "";
      if (!trimmed) {
        return null;
      }
      // Accept room IDs or room names
      const numeric = trimmed.replace(/^campfire:/i, "").replace(/^room:/i, "");
      return numeric || null;
    },
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return /^\d+$/.test(value) || /^room:/i.test(raw);
      },
      hint: "<room_id>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveCampfireAccount({ cfg, accountId });
      const groups = account.config.groups ?? {};
      const q = query?.trim().toLowerCase() || "";
      const entries = Object.keys(groups)
        .filter((key) => key && key !== "*")
        .filter((key) => (q ? key.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return entries;
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      const resolved = inputs.map((input) => {
        const trimmed = input?.trim() ?? "";
        if (!trimmed) {
          return { input, resolved: false, note: "empty target" };
        }
        const normalized = trimmed.replace(/^campfire:/i, "").replace(/^room:/i, "");
        if (kind === "group" && /^\d+$/.test(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        // Accept room names as-is for group lookups
        if (kind === "group") {
          return { input, resolved: true, id: normalized };
        }
        return { input, resolved: false, note: "use room ID or name" };
      });
      return resolved;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "campfire",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "CAMPFIRE_BOT_KEY env vars can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "Campfire requires --token (bot key in format {id}-{token}).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "campfire",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "campfire",
            })
          : namedConfig;
      const patch = input.useEnv ? {} : input.token ? { botKey: input.token } : {};
      const webhookPath = input.webhookPath?.trim();
      const baseUrl = input.baseUrl?.trim();
      const configPatch = {
        ...patch,
        ...(webhookPath ? { webhookPath } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            campfire: {
              ...((next.channels?.["campfire"] ?? {}) as Record<string, unknown>),
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
          campfire: {
            ...((next.channels?.["campfire"] ?? {}) as Record<string, unknown>),
            enabled: true,
            accounts: {
              ...(next.channels?.["campfire"] as { accounts?: Record<string, unknown> })?.accounts,
              [accountId]: {
                ...(next.channels?.["campfire"] as { accounts?: Record<string, unknown> })
                  ?.accounts?.[accountId],
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
    chunker: (text, limit) => getCampfireRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const allowList = allowListRaw.filter((entry) => entry !== "*" && /^\d+$/.test(entry));

      if (trimmed) {
        const normalized = trimmed.replace(/^campfire:/i, "").replace(/^room:/i, "");
        if (!normalized) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError("Campfire", "<room_id>"),
          };
        }
        return { ok: true, to: normalized };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: missingTargetError("Campfire", "<room_id>"),
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveCampfireAccount({ cfg, accountId });
      if (!account.baseUrl || !account.botKey) {
        throw new Error("Campfire credentials not configured");
      }
      const roomPath = `/rooms/${to}/${account.botKey}/messages`;
      const result = await sendCampfireMessage({
        account,
        roomPath,
        text,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        channel: "campfire",
        messageId: "",
        chatId: to,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        throw new Error("Campfire mediaUrl is required.");
      }
      const account = resolveCampfireAccount({ cfg, accountId });
      if (!account.baseUrl || !account.botKey) {
        throw new Error("Campfire credentials not configured");
      }
      const roomPath = `/rooms/${to}/${account.botKey}/messages`;
      const runtime = getCampfireRuntime();
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          (
            cfg.channels?.["campfire"] as
              | { accounts?: Record<string, { mediaMaxMb?: number }>; mediaMaxMb?: number }
              | undefined
          )?.accounts?.[accountId]?.mediaMaxMb ??
          (cfg.channels?.["campfire"] as { mediaMaxMb?: number } | undefined)?.mediaMaxMb,
        accountId,
      });
      const loaded = await runtime.channel.media.fetchRemoteMedia(mediaUrl, {
        maxBytes: maxBytes ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
      });

      // Send caption first if present
      if (text?.trim()) {
        const textResult = await sendCampfireMessage({
          account,
          roomPath,
          text,
        });
        if (!textResult.ok) {
          throw new Error(textResult.error);
        }
      }

      // Send attachment
      const result = await sendCampfireAttachment({
        account,
        roomPath,
        buffer: loaded.buffer,
        filename: loaded.filename ?? "attachment",
        contentType: loaded.contentType,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        channel: "campfire",
        messageId: "",
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) {
          return [];
        }
        const issues = [];
        if (!entry.baseUrl) {
          issues.push({
            channel: "campfire",
            accountId,
            kind: "config",
            message: "Campfire baseUrl is missing (set channels.campfire.baseUrl).",
            fix: "Set channels.campfire.baseUrl to your Campfire instance URL.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      baseUrl: snapshot.baseUrl ?? null,
      webhookPath: snapshot.webhookPath ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeCampfire(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      baseUrl: account.baseUrl,
      webhookPath: account.config.webhookPath,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Campfire webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveCampfireWebhookPath({ account }),
        baseUrl: account.baseUrl,
      });
      const unregister = await startCampfireMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
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
