import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChannelAccountSnapshot, ChannelPlugin, ClawdbotConfig } from "clawdbot/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectBlueBubblesStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
} from "clawdbot/plugin-sdk";

import {
  listBlueBubblesAccountIds,
  type ResolvedBlueBubblesAccount,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import { probeBlueBubbles } from "./probe.js";
import { sendMessageBlueBubbles } from "./send.js";
import { sendBlueBubblesAttachment } from "./attachments.js";
import { normalizeBlueBubblesHandle } from "./targets.js";
import { bluebubblesMessageActions } from "./actions.js";
import { monitorBlueBubblesProvider, resolveWebhookPathFromConfig } from "./monitor.js";
import { blueBubblesOnboardingAdapter } from "./onboarding.js";
import { getBlueBubblesRuntime } from "./runtime.js";

const meta = {
  id: "bluebubbles",
  label: "BlueBubbles",
  selectionLabel: "BlueBubbles (macOS app)",
  docsPath: "/channels/bluebubbles",
  docsLabel: "bluebubbles",
  blurb: "iMessage via the BlueBubbles mac app + REST API.",
  order: 75,
};

const HTTP_URL_RE = /^https?:\/\//i;

function resolveLocalMediaPath(source: string): string {
  if (!source.startsWith("file://")) return source;
  try {
    return fileURLToPath(source);
  } catch {
    throw new Error(`Invalid file:// URL: ${source}`);
  }
}

function resolveFilenameFromSource(source?: string): string | undefined {
  if (!source) return undefined;
  if (source.startsWith("file://")) {
    try {
      return path.basename(fileURLToPath(source)) || undefined;
    } catch {
      return undefined;
    }
  }
  if (HTTP_URL_RE.test(source)) {
    try {
      return path.basename(new URL(source).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
  const base = path.basename(source);
  return base || undefined;
}

export const bluebubblesPlugin: ChannelPlugin<ResolvedBlueBubblesAccount> = {
  id: "bluebubbles",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    effects: true,
    groupManagement: true,
  },
  reload: { configPrefixes: ["channels.bluebubbles"] },
  configSchema: buildChannelConfigSchema(BlueBubblesConfigSchema),
  onboarding: blueBubblesOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listBlueBubblesAccountIds(cfg as ClawdbotConfig),
    resolveAccount: (cfg, accountId) =>
      resolveBlueBubblesAccount({ cfg: cfg as ClawdbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg as ClawdbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "bluebubbles",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "bluebubbles",
        accountId,
        clearBaseFields: ["serverUrl", "password", "name", "webhookPath"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveBlueBubblesAccount({ cfg: cfg as ClawdbotConfig, accountId }).config.allowFrom ??
        []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^bluebubbles:/i, ""))
        .map((entry) => normalizeBlueBubblesHandle(entry)),
  },
  actions: bluebubblesMessageActions,
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as ClawdbotConfig).channels?.bluebubbles?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.bluebubbles.accounts.${resolvedAccountId}.`
        : "channels.bluebubbles.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("bluebubbles"),
        normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, "")),
      };
    },
    collectWarnings: ({ account }) => {
      const groupPolicy = account.config.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- BlueBubbles groups: groupPolicy="open" allows any member to trigger the bot. Set channels.bluebubbles.groupPolicy="allowlist" + channels.bluebubbles.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "bluebubbles",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.httpUrl && !input.password) {
        return "BlueBubbles requires --http-url and --password.";
      }
      if (!input.httpUrl) return "BlueBubbles requires --http-url.";
      if (!input.password) return "BlueBubbles requires --password.";
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "bluebubbles",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "bluebubbles",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            bluebubbles: {
              ...next.channels?.bluebubbles,
              enabled: true,
              ...(input.httpUrl ? { serverUrl: input.httpUrl } : {}),
              ...(input.password ? { password: input.password } : {}),
              ...(input.webhookPath ? { webhookPath: input.webhookPath } : {}),
            },
          },
        } as ClawdbotConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          bluebubbles: {
            ...next.channels?.bluebubbles,
            enabled: true,
            accounts: {
              ...(next.channels?.bluebubbles?.accounts ?? {}),
              [accountId]: {
                ...(next.channels?.bluebubbles?.accounts?.[accountId] ?? {}),
                enabled: true,
                ...(input.httpUrl ? { serverUrl: input.httpUrl } : {}),
                ...(input.password ? { password: input.password } : {}),
                ...(input.webhookPath ? { webhookPath: input.webhookPath } : {}),
              },
            },
          },
        },
      } as ClawdbotConfig;
    },
  },
  pairing: {
    idLabel: "bluebubblesSenderId",
    normalizeAllowEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageBlueBubbles(id, PAIRING_APPROVED_MESSAGE, {
        cfg: cfg as ClawdbotConfig,
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
          error: new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const result = await sendMessageBlueBubbles(to, text, {
        cfg: cfg as ClawdbotConfig,
        accountId: accountId ?? undefined,
      });
      return { channel: "bluebubbles", ...result };
    },
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, accountId } = ctx;
      const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx as {
        mediaPath?: string;
        mediaBuffer?: Uint8Array;
        contentType?: string;
        filename?: string;
        caption?: string;
      };
      const core = getBlueBubblesRuntime();
      const resolvedCaption = caption ?? text;

      let buffer: Uint8Array;
      let resolvedContentType = contentType ?? undefined;
      let resolvedFilename = filename ?? undefined;

      if (mediaBuffer) {
        buffer = mediaBuffer;
        if (!resolvedContentType) {
          const hint = mediaPath ?? mediaUrl;
          const detected = await core.media.detectMime({
            buffer: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
            filePath: hint,
          });
          resolvedContentType = detected ?? undefined;
        }
        if (!resolvedFilename) {
          resolvedFilename = resolveFilenameFromSource(mediaPath ?? mediaUrl);
        }
      } else {
        const source = mediaPath ?? mediaUrl;
        if (!source) {
          throw new Error("BlueBubbles media delivery requires mediaUrl, mediaPath, or mediaBuffer.");
        }
        if (HTTP_URL_RE.test(source)) {
          const fetched = await core.channel.media.fetchRemoteMedia({ url: source });
          buffer = fetched.buffer;
          resolvedContentType = resolvedContentType ?? fetched.contentType ?? undefined;
          resolvedFilename = resolvedFilename ?? fetched.fileName;
        } else {
          const localPath = resolveLocalMediaPath(source);
          const fs = await import("node:fs/promises");
          const data = await fs.readFile(localPath);
          buffer = new Uint8Array(data);
          if (!resolvedContentType) {
            const detected = await core.media.detectMime({
              buffer: data,
              filePath: localPath,
            });
            resolvedContentType = detected ?? undefined;
          }
          if (!resolvedFilename) {
            resolvedFilename = resolveFilenameFromSource(localPath);
          }
        }
      }

      const result = await sendBlueBubblesAttachment({
        to,
        buffer,
        filename: resolvedFilename ?? "attachment",
        contentType: resolvedContentType ?? undefined,
        caption: resolvedCaption ?? undefined,
        opts: {
          cfg: cfg as ClawdbotConfig,
          accountId: accountId ?? undefined,
        },
      });

      return { channel: "bluebubbles", ...result };
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
    collectStatusIssues: collectBlueBubblesStatusIssues,
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
    probeAccount: async ({ account, timeoutMs }) =>
      probeBlueBubbles({
        baseUrl: account.baseUrl,
        password: account.config.password ?? null,
        timeoutMs,
      }),
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
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const webhookPath = resolveWebhookPathFromConfig(account.config);
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
      return monitorBlueBubblesProvider({
        account,
        config: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
        webhookPath,
      });
    },
  },
};
