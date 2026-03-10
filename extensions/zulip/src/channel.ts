import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { resolveChannelGroupToolsPolicy } from "../../../src/config/group-policy.js";
import { ZulipConfigSchema } from "./config-schema.js";
import { getZulipRuntime } from "./runtime.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { normalizeZulipBaseUrl } from "./zulip/client.js";
import { readZulipComponentSpec } from "./zulip/components.js";
import { listZulipDirectoryGroups, listZulipDirectoryPeers } from "./zulip/directory.js";
import { monitorZulipProvider } from "./zulip/monitor.js";
import { probeZulip } from "./zulip/probe.js";
import { sendZulipComponentMessage } from "./zulip/send-components.js";
import { sendMessageZulip } from "./zulip/send.js";

const meta = {
  id: "zulip",
  label: "Zulip",
  selectionLabel: "Zulip (plugin)",
  detailLabel: "Zulip Bot",
  docsPath: "/channels/zulip",
  docsLabel: "zulip",
  blurb: "self-hosted team chat with streams & topics; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 66,
  quickstartAllowFrom: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(zulip|user):/i, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^(zulip|user):/i, "").toLowerCase();
}

function listConfiguredZulipAccounts(cfg: Parameters<typeof listZulipAccountIds>[0]) {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled)
    .filter((account) =>
      Boolean(account.botEmail?.trim() && account.botApiKey?.trim() && account.baseUrl?.trim()),
    );
}

const zulipMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const actions: ChannelMessageActionName[] = [];
    if (listConfiguredZulipAccounts(cfg).length > 0) {
      actions.push("send");
    }
    return actions;
  },
  supportsAction: ({ action }) => action === "send",
  supportsButtons: ({ cfg }) =>
    listConfiguredZulipAccounts(cfg).some((account) => account.config.widgetsEnabled === true),
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action !== "send") {
      throw new Error(`Unsupported Zulip action: ${action}`);
    }

    const to =
      typeof params.to === "string"
        ? params.to.trim()
        : typeof params.target === "string"
          ? params.target.trim()
          : "";
    if (!to) {
      throw new Error("Zulip send requires a target (to).");
    }

    const message = typeof params.message === "string" ? params.message : "";
    const replyToTopic = typeof params.replyTo === "string" ? params.replyTo : undefined;
    const mediaUrl =
      typeof params.media === "string"
        ? params.media.trim() || undefined
        : typeof params.path === "string"
          ? params.path.trim() || undefined
          : typeof params.filePath === "string"
            ? params.filePath.trim() || undefined
            : undefined;
    const resolvedAccountId = accountId || undefined;
    const rawButtons = Array.isArray(params.buttons) ? params.buttons : undefined;
    const sessionKey = typeof params.__sessionKey === "string" ? params.__sessionKey : undefined;
    const agentId = typeof params.__agentId === "string" ? params.__agentId : undefined;

    if (rawButtons?.length && (!sessionKey || !agentId)) {
      console.warn(
        "[zulip] send action requested buttons without sessionKey/agentId; degrading to markdown text",
      );
    }

    const result =
      rawButtons && rawButtons.length > 0
        ? await sendZulipComponentMessage(
            to,
            message,
            readZulipComponentSpec({
              heading: typeof params.heading === "string" ? params.heading : undefined,
              buttons: rawButtons,
            }),
            {
              cfg,
              accountId: resolvedAccountId,
              replyToTopic,
              mediaUrl,
              sessionKey,
              agentId,
            },
          )
        : await sendMessageZulip(to, message, {
            cfg,
            accountId: resolvedAccountId,
            replyToTopic,
            mediaUrl,
          });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            channel: "zulip",
            messageId: result.messageId,
            target: result.target,
          }),
        },
      ],
      details: {},
    };
  },
};

export const zulipPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  id: "zulip",
  meta: { ...meta },
  pairing: {
    idLabel: "zulipUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[zulip] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    threads: true,
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.zulip"] },
  configSchema: buildChannelConfigSchema(ZulipConfigSchema),
  config: {
    listAccountIds: (cfg) => listZulipAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZulipAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZulipAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        clearBaseFields: ["botEmail", "botApiKey", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.botEmail && account.botApiKey && account.baseUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botEmail && account.botApiKey && account.baseUrl),
      botEmailSource: account.botEmailSource,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? []).map((e) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((e) => formatAllowEntry(String(e))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.zulip?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.zulip.accounts.${resolvedAccountId}.`
        : "channels.zulip.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zulip"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Zulip streams: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.zulip.groupPolicy="allowlist" + channels.zulip.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveToolPolicy: ({
      cfg,
      accountId,
      groupId,
      senderId,
      senderName,
      senderUsername,
      senderE164,
    }) =>
      resolveChannelGroupToolsPolicy({
        cfg,
        channel: "zulip",
        groupId,
        accountId,
        senderId,
        senderName,
        senderUsername,
        senderE164,
      }),
  },
  actions: zulipMessageActions,
  directory: {
    self: async () => null,
    listPeers: async (params) => listZulipDirectoryPeers(params),
    listPeersLive: async (params) => listZulipDirectoryPeers(params),
    listGroups: async (params) => listZulipDirectoryGroups(params),
    listGroupsLive: async (params) => listZulipDirectoryGroups(params),
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim(),
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^(stream:|dm:)/i.test(trimmed)) {
          return true;
        }
        const lastColon = trimmed.lastIndexOf(":");
        return lastColon > 0 && lastColon < trimmed.length - 1;
      },
      hint: "<stream:NAME:topic:TOPIC|stream:NAME:TOPIC|dm:USER_ID|dm:EMAIL>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 10000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Zulip requires --to <stream:NAME:topic:TOPIC|dm:USER_ID|dm:EMAIL>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendMessageZulip(to, text, {
        accountId: accountId ?? undefined,
        replyToTopic: replyToId ?? undefined,
      });
      return { channel: "zulip", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const result = await sendMessageZulip(to, text, {
        accountId: accountId ?? undefined,
        mediaUrl,
        replyToTopic: replyToId ?? undefined,
      });
      return { channel: "zulip", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const email = account.botEmail?.trim();
      const key = account.botApiKey?.trim();
      const baseUrl = account.baseUrl?.trim();
      if (!email || !key || !baseUrl) {
        return { ok: false, error: "bot credentials or baseUrl missing" };
      }
      return await probeZulip(baseUrl, email, key, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botEmail && account.botApiKey && account.baseUrl),
      botEmailSource: account.botEmailSource,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({ cfg, channelKey: "zulip", accountId, name }),
    validateInput: ({ accountId: _accountId, input }) => {
      const zInput = input as Record<string, unknown>;
      const email = zInput.botEmail as string | undefined;
      const key = (zInput.botApiKey as string | undefined) ?? input.token;
      const baseUrl = input.httpUrl;
      if (!email || !key || !baseUrl) {
        return "Zulip requires --bot-email, --bot-api-key (or --token), and --http-url.";
      }
      if (baseUrl && !normalizeZulipBaseUrl(baseUrl)) {
        return "Zulip --http-url must include a valid base URL.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const zInput = input as Record<string, unknown>;
      const email = zInput.botEmail as string | undefined;
      const key = (zInput.botApiKey as string | undefined) ?? input.token;
      const baseUrl = input.httpUrl?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "zulip" })
          : namedConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...next.channels?.zulip,
              enabled: true,
              ...(email ? { botEmail: email } : {}),
              ...(key ? { botApiKey: key } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zulip: {
            ...next.channels?.zulip,
            enabled: true,
            accounts: {
              ...next.channels?.zulip?.accounts,
              [accountId]: {
                ...next.channels?.zulip?.accounts?.[accountId],
                enabled: true,
                ...(email ? { botEmail: email } : {}),
                ...(key ? { botApiKey: key } : {}),
                ...(baseUrl ? { baseUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting zulip channel`);
      return monitorZulipProvider({
        botEmail: account.botEmail ?? undefined,
        botApiKey: account.botApiKey ?? undefined,
        baseUrl: account.baseUrl ?? undefined,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
