import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedViberAccount, ViberProbe } from "./types.js";
import { getViberRuntime } from "./runtime.js";
import { sendMessage, getAccountInfo, setWebhook, removeWebhook } from "./api.js";
import {
  verifySignature,
  parseWebhookEvent,
  isMessageEvent,
  isConversationStarted,
  extractMessageText,
  markdownToViber,
} from "./webhook.js";
import type { ViberSendMessageParams } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNT_ID = "default";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

function resolveMediaType(url: string): "picture" | "video" | "file" {
  const lower = url.toLowerCase().split("?")[0] ?? "";
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "picture";
  if (VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "video";
  return "file";
}

function buildMediaMessage(
  receiver: string,
  mediaUrl: string,
  text?: string,
  senderName?: string,
  senderAvatar?: string,
): ViberSendMessageParams {
  const type = resolveMediaType(mediaUrl);
  const base: ViberSendMessageParams = {
    receiver,
    type,
    sender: senderName ? { name: senderName, avatar: senderAvatar } : undefined,
  };

  switch (type) {
    case "picture":
      return { ...base, media: mediaUrl, text: text ?? "" };
    case "video":
      return { ...base, media: mediaUrl, size: 0, text: text ?? "" };
    case "file": {
      let fileName = "file";
      try {
        const path = new URL(mediaUrl).pathname;
        const segments = path.split("/");
        fileName = segments[segments.length - 1] ?? "file";
      } catch {
        // ignore
      }
      return { ...base, media: mediaUrl, size: 0, file_name: fileName, text: undefined };
    }
  }
}

const VIBER_MAX_TEXT_LENGTH = 7000;

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", limit);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(" ", limit);
    if (splitIdx <= 0) splitIdx = limit;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getViberSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return (cfg as Record<string, unknown>).channels &&
    typeof (cfg as Record<string, unknown>).channels === "object"
    ? ((cfg as Record<string, unknown>).channels as Record<string, unknown>).viber as
        | Record<string, unknown>
        | undefined
    : undefined;
}

function resolveViberToken(cfg: OpenClawConfig, accountId?: string | null): {
  token: string;
  source: "config" | "env" | "none";
} {
  const section = getViberSection(cfg);
  const envToken = process.env.VIBER_BOT_TOKEN?.trim() ?? "";
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;

  // Check accounts section first
  if (section?.accounts && typeof section.accounts === "object") {
    const accounts = section.accounts as Record<string, Record<string, unknown>>;
    const entry = accounts[resolvedId];
    if (entry?.token && typeof entry.token === "string" && entry.token.trim()) {
      return { token: entry.token.trim(), source: "config" };
    }
  }

  // Check top-level token
  if (resolvedId === DEFAULT_ACCOUNT_ID) {
    if (section?.token && typeof section.token === "string" && section.token.trim()) {
      return { token: (section.token as string).trim(), source: "config" };
    }
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}

function resolveViberAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedViberAccount {
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = getViberSection(cfg);
  const { token, source } = resolveViberToken(cfg, resolvedId);

  // Merge account-level config over top-level
  let accountSection: Record<string, unknown> = {};
  if (section?.accounts && typeof section.accounts === "object") {
    const accounts = section.accounts as Record<string, Record<string, unknown>>;
    accountSection = accounts[resolvedId] ?? {};
  }

  const configSection =
    resolvedId === DEFAULT_ACCOUNT_ID ? { ...section, ...accountSection } : accountSection;

  return {
    accountId: resolvedId,
    token,
    tokenSource: source,
    webhookUrl: (configSection.webhookUrl as string) ?? undefined,
    name: (configSection.name as string) ?? (section?.name as string) ?? undefined,
    avatar: (configSection.avatar as string) ?? undefined,
    enabled: configSection.enabled !== false,
    config: {
      dmPolicy: (configSection.dmPolicy as string) ?? undefined,
      allowFrom: Array.isArray(configSection.allowFrom)
        ? configSection.allowFrom.map(String)
        : undefined,
      webhookUrl: (configSection.webhookUrl as string) ?? undefined,
      webhookPath: (configSection.webhookPath as string) ?? undefined,
      proxy: (configSection.proxy as string) ?? undefined,
    },
  };
}

function listViberAccountIds(cfg: OpenClawConfig): string[] {
  const section = getViberSection(cfg);
  if (!section) return [];

  const ids: string[] = [];

  // If top-level token or env token exists, include default
  const { token: defaultToken } = resolveViberToken(cfg, DEFAULT_ACCOUNT_ID);
  if (defaultToken) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  // Named accounts
  if (section.accounts && typeof section.accounts === "object") {
    for (const key of Object.keys(section.accounts as Record<string, unknown>)) {
      if (key !== DEFAULT_ACCOUNT_ID && !ids.includes(key)) {
        ids.push(key);
      }
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Channel Plugin
// ---------------------------------------------------------------------------

export const viberPlugin: ChannelPlugin<ResolvedViberAccount, ViberProbe> = {
  id: "viber",

  meta: {
    id: "viber",
    label: "Viber",
    selectionLabel: "Viber (Bot API)",
    detailLabel: "Viber Bot",
    docsPath: "/channels/viber",
    docsLabel: "viber",
    blurb: "connect via Viber Bot API — create a bot at partners.viber.com.",
    systemImage: "bubble.left.and.text.bubble.right",
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },

  defaults: {
    queue: {
      debounceMs: 500,
    },
  },

  reload: { configPrefixes: ["channels.viber"] },

  config: {
    listAccountIds: (cfg) => listViberAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveViberAccount(cfg, accountId),
    defaultAccountId: (cfg) => {
      const ids = listViberAccountIds(cfg);
      return ids.length > 0 ? ids[0] : "";
    },
    isConfigured: (account) => Boolean(account.token?.trim()),
    unconfiguredReason: (account) => {
      if (!account.token?.trim()) return "not configured";
      return "not configured";
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveViberAccount(cfg, accountId).config.allowFrom,
    resolveDefaultTo: ({ cfg, accountId }) => {
      const section = getViberSection(cfg);
      if (!section) return undefined;
      const val = section.defaultTo;
      return val != null ? String(val) : undefined;
    },
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const section = getViberSection(cfg);
      const useAccountPath = Boolean(
        section?.accounts &&
          (section.accounts as Record<string, unknown>)[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.viber.accounts.${resolvedAccountId}.`
        : "channels.viber.";

      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: `Add their Viber user ID to ${basePath}allowFrom or run: openclaw approve viber <userId>`,
        normalizeEntry: (raw: string) => raw.trim(),
      };
    },
  },

  pairing: {
    idLabel: "viberUserId",
    normalizeAllowEntry: (entry) => entry.trim(),
    notifyApproval: async ({ cfg, id }) => {
      const { token } = resolveViberToken(cfg, DEFAULT_ACCOUNT_ID);
      if (!token) {
        throw new Error("viber token not configured");
      }
      const section = getViberSection(cfg);
      const senderName = (section?.name as string) ?? "OpenClaw";
      await sendMessage(token, {
        receiver: id,
        type: "text",
        text: "✅ Your access has been approved. You can now send messages.",
        sender: { name: senderName },
      });
    },
  },

  setup: {
    resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
    validateInput: ({ input }) => {
      if (!input.useEnv && !input.token) {
        return "Viber requires a bot token. Get one from https://partners.viber.com/";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const next = structuredClone(cfg) as Record<string, unknown>;
      if (!next.channels) next.channels = {};
      const channels = next.channels as Record<string, unknown>;
      if (!channels.viber) channels.viber = {};
      const viber = channels.viber as Record<string, unknown>;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        viber.enabled = true;
        if (input.useEnv) {
          // Token comes from VIBER_BOT_TOKEN env
        } else if (input.token) {
          viber.token = input.token;
        }
        if (input.name) viber.name = input.name;
      } else {
        viber.enabled = true;
        if (!viber.accounts) viber.accounts = {};
        const accounts = viber.accounts as Record<string, Record<string, unknown>>;
        if (!accounts[accountId]) accounts[accountId] = {};
        const entry = accounts[accountId];
        entry.enabled = true;
        if (input.token) entry.token = input.token;
        if (input.name) entry.name = input.name;
      }

      return next as unknown as OpenClawConfig;
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "text",
    textChunkLimit: VIBER_MAX_TEXT_LENGTH,

    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveViberAccount(cfg, accountId);
      const converted = markdownToViber(text);
      const senderName = account.name ?? "OpenClaw";

      const result = await sendMessage(account.token, {
        receiver: to,
        type: "text",
        text: converted,
        sender: { name: senderName, avatar: account.avatar },
      });

      return {
        channel: "viber",
        messageId: result.message_token ? String(result.message_token) : undefined,
      };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveViberAccount(cfg, accountId);

      if (!mediaUrl) {
        return { channel: "viber", messageId: undefined };
      }

      const msg = buildMediaMessage(to, mediaUrl, text, account.name ?? "OpenClaw", account.avatar);
      const result = await sendMessage(account.token, msg);

      return {
        channel: "viber",
        messageId: result.message_token ? String(result.message_token) : undefined,
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
    probeAccount: async ({ account, timeoutMs }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const info = await getAccountInfo(account.token, controller.signal);
        clearTimeout(timer);

        if (info.status === 0) {
          return {
            ok: true,
            accountName: info.name,
            uri: info.uri,
            subscribersCount: info.subscribers_count,
          };
        }
        return { ok: false, error: info.status_message };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.token?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: account.config.webhookUrl ? "webhook" : "none",
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, log, abortSignal, setStatus, getStatus } = ctx;
      const token = account.token?.trim();

      if (!token) {
        log?.error?.(`[${account.accountId}] Viber bot token is not configured`);
        throw new Error("Viber bot token not configured");
      }

      // Probe the bot
      let botLabel = "";
      try {
        const info = await getAccountInfo(token);
        if (info.status === 0 && info.name) {
          botLabel = ` (${info.name})`;
        }
      } catch (err) {
        log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
      }

      log?.info(`[${account.accountId}] starting Viber provider${botLabel}`);

      // Register webhook if URL is configured
      if (account.config.webhookUrl) {
        try {
          const result = await setWebhook(
            token,
            account.config.webhookUrl,
            ["message", "subscribed", "unsubscribed", "conversation_started"],
            abortSignal,
          );
          if (result.status === 0) {
            log?.info?.(`[${account.accountId}] Viber webhook registered: ${account.config.webhookUrl}`);
          } else {
            log?.error?.(
              `[${account.accountId}] Failed to register Viber webhook: ${result.status_message}`,
            );
          }
        } catch (err) {
          log?.error?.(`[${account.accountId}] Failed to register Viber webhook: ${err}`);
        }
      }

      // Update status
      const snapshot = getStatus();
      setStatus({
        ...snapshot,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      // Keep alive until abort
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },

    logoutAccount: async ({ accountId, cfg }) => {
      const section = getViberSection(cfg);
      const nextCfg = structuredClone(cfg) as Record<string, unknown>;
      let cleared = false;
      let changed = false;

      if (section) {
        const channels = (nextCfg as Record<string, unknown>).channels as Record<string, unknown>;
        const viber = channels?.viber as Record<string, unknown> | undefined;

        if (viber) {
          if (accountId === DEFAULT_ACCOUNT_ID && viber.token) {
            delete viber.token;
            cleared = true;
            changed = true;
          }

          const accounts = viber.accounts as Record<string, Record<string, unknown>> | undefined;
          if (accounts?.[accountId]) {
            const entry = accounts[accountId];
            if (entry?.token) {
              cleared = true;
              delete entry.token;
              changed = true;
            }
            if (Object.keys(entry).length === 0) {
              delete accounts[accountId];
              changed = true;
            }
          }
        }
      }

      if (changed) {
        await getViberRuntime().config.writeConfigFile(nextCfg as unknown as OpenClawConfig);
      }

      const envToken = Boolean(process.env.VIBER_BOT_TOKEN?.trim());
      const resolved = resolveViberAccount(
        changed ? (nextCfg as unknown as OpenClawConfig) : cfg,
        accountId,
      );
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken, loggedOut };
    },
  },

  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) return null;
      // Viber user IDs are opaque strings; just pass through
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw?.trim()),
      hint: "<viberUserId>",
    },
  },
};
