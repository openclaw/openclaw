import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk";
import {
  listDeltaChatAccountIds,
  resolveDefaultDeltaChatAccountId,
  resolveDeltaChatAccount,
  type ResolvedDeltaChatAccount,
} from "./accounts.js";
import { deltachatMessageActions } from "./actions.js";
import { DeltaChatConfigSchema } from "./config-schema.js";
import { monitorDeltaChatProvider } from "./monitor.js";
import { deltachatOnboardingAdapter } from "./onboarding.js";
import { generatePairingQrCode } from "./pairing.js";
import { probeDeltaChat } from "./probe.js";
import { rpcServerManager } from "./rpc-server.js";
import { sendMessageDeltaChat, sendMediaDeltaChat } from "./send.js";
import {
  normalizeDeltaChatMessagingTarget,
  looksLikeDeltaChatTargetId,
  normalizeDeltaChatHandle,
} from "./targets.js";
import type { CoreConfig } from "./types.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import { ensureDataDir } from "./utils.js";

// Extended setup input for deltachat-specific fields not in the core ChannelSetupInput
type DeltaChatSetupInput = ChannelSetupInput & {
  chatmail_qr?: string;
  addr?: string;
  mail_pw?: string;
  data_dir?: string;
};

const meta = {
  id: "deltachat",
  label: "Delta.Chat",
  selectionLabel: "Delta.Chat (plugin)",
  docsPath: "/channels/deltachat",
  docsLabel: "deltachat",
  blurb: "end-to-end encrypted messaging via Delta.Chat core.",
  order: 80,
  quickstartAllowFrom: true,
};

function buildDeltaChatConfigUpdate(
  cfg: CoreConfig,
  input: {
    dataDir?: string;
    addr?: string;
    mail_pw?: string;
    chatmailQr?: string;
    bot?: string;
    e2ee_enabled?: string;
    initialSyncLimit?: number;
  },
): CoreConfig {
  const existing = cfg.channels?.deltachat ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      deltachat: {
        ...existing,
        enabled: true,
        ...(input.dataDir ? { dataDir: input.dataDir } : {}),
        ...(input.addr ? { addr: input.addr } : {}),
        ...(input.mail_pw ? { mail_pw: input.mail_pw } : {}),
        ...(input.chatmailQr ? { chatmailQr: input.chatmailQr } : {}),
        ...(input.bot ? { bot: input.bot } : {}),
        ...(input.e2ee_enabled ? { e2ee_enabled: input.e2ee_enabled } : {}),
        ...(typeof input.initialSyncLimit === "number"
          ? { initialSyncLimit: input.initialSyncLimit }
          : {}),
      },
    },
  };
}

export const deltachatPlugin: ChannelPlugin<ResolvedDeltaChatAccount> = {
  id: "deltachat",
  meta,
  onboarding: deltachatOnboardingAdapter,
  pairing: {
    idLabel: "deltachatEmail",
    normalizeAllowEntry: (entry) => entry.replace(/^deltachat:/i, "").trim(),
    notifyApproval: async ({ id }) => {
      // Delta.Chat doesn't have a direct notification API, but we can log it
      console.log(`Delta.Chat pairing approved for: ${id}`);
    },
    generateQrCode: async ({ cfg, accountId, output, format }) => {
      const account = resolveDeltaChatAccount({ cfg: cfg as CoreConfig, accountId });
      const qrCodeData = await generatePairingQrCode({
        cfg: cfg as CoreConfig,
        accountId: account.accountId,
        output: output ?? "terminal",
        format: format ?? "text",
      });
      return qrCodeData;
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    groupManagement: false,
  },
  reload: { configPrefixes: ["channels.deltachat"] },
  configSchema: buildChannelConfigSchema(DeltaChatConfigSchema),
  config: {
    listAccountIds: (cfg) => listDeltaChatAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveDeltaChatAccount({ cfg: cfg as CoreConfig, accountId: accountId ?? undefined }),
    defaultAccountId: (cfg) => resolveDefaultDeltaChatAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "deltachat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "deltachat",
        accountId,
        clearBaseFields: [
          "name",
          "dataDir",
          "addr",
          "mail_pw",
          "bot",
          "e2ee_enabled",
          "chatmailQr",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg }) =>
      ((cfg as CoreConfig).channels?.deltachat?.dm?.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^deltachat:/i, ""))
        .map((entry) => normalizeDeltaChatHandle(entry)),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "pairing",
      allowFrom: account.config.dm?.allowFrom ?? [],
      policyPath: "channels.deltachat.dm.policy",
      allowFromPath: "channels.deltachat.dm.allowFrom",
      approveHint: formatPairingApproveHint("deltachat"),
      normalizeEntry: (raw) =>
        raw
          .replace(/^deltachat:/i, "")
          .trim()
          .toLowerCase(),
    }),
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = (cfg as CoreConfig).channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        '- Delta.Chat groups: groupPolicy="open" allows any member to trigger the bot. Set channels.deltachat.groupPolicy="allowlist" + channels.deltachat.groups to restrict rooms.',
      ];
    },
  },
  groups: {
    resolveRequireMention: (params) => {
      // Resolve requireMention for DeltaChat groups
      const account = resolveDeltaChatAccount({
        cfg: params.cfg as CoreConfig,
        accountId: params.accountId ?? undefined,
      });
      const groups = account.config.groups ?? {};
      const groupConfig = groups[params.groupId ?? ""] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
    resolveToolPolicy: (params) => {
      // Resolve tool policy for DeltaChat groups
      const account = resolveDeltaChatAccount({
        cfg: params.cfg as CoreConfig,
        accountId: params.accountId ?? undefined,
      });
      const groups = account.config.groups ?? {};
      const groupConfig = groups[params.groupId ?? ""] ?? groups["*"];
      const tools = groupConfig?.tools;
      // Convert deltachat's string policy to GroupToolPolicyConfig:
      // "allow" (or unset) = no restriction; object = pass through
      if (!tools || typeof tools === "string") return undefined;
      return tools;
    },
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => {
      const mode = (cfg as CoreConfig).channels?.deltachat?.replyToMode ?? "off";
      // Map deltachat's replyToMode values to the core's "all" | "first" | "off" enum
      if (mode === "thread") return "all";
      if (mode === "reply") return "first";
      return "off";
    },
    buildToolContext: ({ context, hasRepliedRef }) => {
      const currentTarget = context.To;
      return {
        currentChannelId: currentTarget?.trim() || undefined,
        currentThreadTs:
          context.MessageThreadId != null ? String(context.MessageThreadId) : context.ReplyToId,
        hasRepliedRef,
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeDeltaChatMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeDeltaChatTargetId,
      hint: "<email|chat_id:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveDeltaChatAccount({
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      });
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();

      for (const entry of account.config.dm?.allowFrom ?? []) {
        const raw = String(entry).trim();
        if (!raw || raw === "*") {
          continue;
        }
        ids.add(raw.replace(/^deltachat:/i, ""));
      }

      for (const entry of account.config.groupAllowFrom ?? []) {
        const raw = String(entry).trim();
        if (!raw || raw === "*") {
          continue;
        }
        ids.add(raw.replace(/^deltachat:/i, ""));
      }

      const groups = account.config.groups ?? {};
      for (const group of Object.values(groups)) {
        for (const entry of group.users ?? []) {
          const raw = String(entry).trim();
          if (!raw || raw === "*") {
            continue;
          }
          ids.add(raw.replace(/^deltachat:/i, ""));
        }
      }

      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          const cleaned = lowered.startsWith("email:") ? raw.slice("email:".length).trim() : raw;
          return `email:${cleaned}`;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({
          kind: "user",
          id,
        }));
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveDeltaChatAccount({
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      });
      const q = query?.trim().toLowerCase() || "";
      const groups = account.config.groups ?? {};
      return Object.keys(groups)
        .filter((key) => key !== "*")
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group" as const, id }));
    },
    listPeersLive: async () => [],
    listGroupsLive: async ({ cfg, accountId, query, limit }) => {
      const account = resolveDeltaChatAccount({
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      });
      const groups = account.config.groups ?? {};
      const chatIds = Object.keys(groups).filter((key) => key !== "*");
      if (chatIds.length === 0) return [];

      const dc = rpcServerManager.get();
      if (!dc) return [];

      // Get the first Delta.Chat account to query chat info
      const accounts = await dc.rpc.getAllAccounts().catch(() => []);
      const dcAccount = accounts[0];
      if (!dcAccount) return [];

      const q = query?.trim().toLowerCase() || "";
      const entries: Array<{ kind: "group"; id: string; name?: string }> = [];

      for (const chatIdStr of chatIds) {
        const numericId = Number(chatIdStr);
        if (!Number.isFinite(numericId) || numericId <= 0) continue;
        try {
          const chat = await dc.rpc.getBasicChatInfo(dcAccount.id, numericId);
          const name = chat.name || undefined;
          if (q && !chatIdStr.includes(q) && !name?.toLowerCase().includes(q)) continue;
          entries.push({ kind: "group", id: chatIdStr, name });
        } catch {
          // Chat may have been deleted; include with ID only
          if (!q || chatIdStr.includes(q)) {
            entries.push({ kind: "group", id: chatIdStr });
          }
        }
      }

      return limit && limit > 0 ? entries.slice(0, limit) : entries;
    },
  },
  resolver: {
    resolveTargets: async ({ cfg, inputs }) => {
      const account = resolveDeltaChatAccount({
        cfg: cfg as CoreConfig,
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const groups = account.config.groups ?? {};

      return inputs.map((input) => {
        const trimmed = input.trim();
        const lowered = trimmed.toLowerCase();

        // Handle group: prefix - group IDs are chat IDs
        if (lowered.startsWith("group:")) {
          const chatId = trimmed.slice("group:".length).trim();
          return { input, id: chatId, resolved: true };
        }

        // Check if it's a numeric chat ID
        if (/^\d+$/.test(trimmed)) {
          return { input, id: trimmed, resolved: true };
        }

        // Check if it's an email address
        if (/^[^@]+@[^@]+\.[^@]+$/.test(trimmed)) {
          return { input, id: trimmed, resolved: true };
        }

        // Check if it's a group name in the config (keyed by chat ID)
        // Look up the group name in the config to find the corresponding chat ID
        for (const [chatId] of Object.entries(groups)) {
          if (chatId === trimmed) {
            return { input, id: chatId, resolved: true };
          }
        }

        // Default: treat as email address
        return { input, id: trimmed, resolved: true };
      });
    },
  },
  actions: deltachatMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "deltachat",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      const dc = input as DeltaChatSetupInput;
      if (dc.useEnv) {
        return null;
      }
      if (!dc.chatmail_qr && !dc.addr) {
        return "Delta.Chat requires --addr or --chatmail-qr";
      }
      if (!dc.chatmail_qr && !dc.mail_pw) {
        return "Delta.Chat requires --mail-pw when using --addr";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const dc = input as DeltaChatSetupInput;
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "deltachat",
        accountId: DEFAULT_ACCOUNT_ID,
        name: dc.name,
      });
      if (dc.useEnv) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            deltachat: {
              ...namedConfig.channels?.deltachat,
              enabled: true,
            },
          },
        } as CoreConfig;
      }
      return buildDeltaChatConfigUpdate(namedConfig as CoreConfig, {
        dataDir: dc.data_dir?.trim(),
        addr: dc.addr?.trim(),
        mail_pw: dc.mail_pw?.trim(),
        chatmailQr: dc.chatmail_qr?.trim(),
        bot: "1",
        e2ee_enabled: "1",
        initialSyncLimit: dc.initialSyncLimit,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Delta.Chat requires --to <email>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const result = await sendMessageDeltaChat(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        replyToMessageId: replyToId ? parseInt(replyToId, 10) : undefined,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to send message");
      }
      return {
        channel: "deltachat" as const,
        messageId: result.messageId ?? "",
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
      if (!mediaUrl) {
        throw new Error("mediaUrl is required for sendMedia");
      }
      const result = await sendMediaDeltaChat({
        cfg,
        to,
        text,
        mediaUrl,
        accountId: accountId ?? undefined,
        replyToMessageId: replyToId ? parseInt(replyToId, 10) : undefined,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to send media");
      }
      return {
        channel: "deltachat" as const,
        messageId: result.messageId ?? "",
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
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "deltachat",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ timeoutMs }) => {
      try {
        return await probeDeltaChat({ _timeoutMs: timeoutMs });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider`);
      return monitorDeltaChatProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        initialSyncLimit: account.config.initialSyncLimit,
        accountId: account.accountId,
      });
    },
    stopAccount: async (ctx) => {
      // Only stop the RPC server if it's running
      if (rpcServerManager.isRunning()) {
        ctx.log?.info("Stopping Delta.Chat RPC server");
        await rpcServerManager.stop();
      }
    },
  },
};
