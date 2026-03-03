/**
 * Kudosity SMS channel plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface to provide cloud-based SMS
 * messaging via the Kudosity v2 API.
 *
 * Outbound: AI responses are sent as SMS via POST /v2/sms
 * Inbound:  User SMS messages arrive via Kudosity webhooks
 */

import type {
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { sendSMS, type KudosityConfig } from "./kudosity-api.js";
import { kudositySmsOnboarding } from "./onboarding.js";
import { getKudositySmsRuntime } from "./runtime.js";

// ─── Config Types ────────────────────────────────────────────────────────────

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_KEY = "kudosity-sms";

export interface KudositySmsAccount {
  accountId: string;
  apiKey: string;
  sender: string;
  webhookSecret?: string;
}

// ─── Config Adapter ──────────────────────────────────────────────────────────

/**
 * Resolves Kudosity SMS credentials from OpenClaw's config system.
 *
 * Implements the ChannelConfigAdapter interface with account management
 * methods required by the plugin system (listAccountIds, resolveAccount, etc.).
 *
 * Reads from the nested config structure at cfg.channels["kudosity-sms"]
 * or falls back to environment variables:
 * - KUDOSITY_API_KEY
 * - KUDOSITY_SENDER
 * - KUDOSITY_WEBHOOK_SECRET
 */
const configAdapter: ChannelConfigAdapter<KudositySmsAccount> = {
  /**
   * List all configured account IDs.
   * Kudosity SMS is a single-account channel — always returns ["default"].
   */
  listAccountIds(_cfg) {
    return [DEFAULT_ACCOUNT_ID];
  },

  /**
   * Resolve a Kudosity SMS account from the config.
   * Reads API key, sender, and webhook secret from nested config or env vars.
   */
  resolveAccount(cfg, _accountId) {
    const section = (cfg as any).channels?.[CHANNEL_KEY];
    const apiKey = (section?.apiKey as string) || process.env.KUDOSITY_API_KEY || "";
    const sender = (section?.sender as string) || process.env.KUDOSITY_SENDER || "";
    const webhookSecret =
      (section?.webhookSecret as string) || process.env.KUDOSITY_WEBHOOK_SECRET || undefined;

    return { accountId: DEFAULT_ACCOUNT_ID, apiKey, sender, webhookSecret };
  },

  /**
   * Return the default account ID (single-account channel).
   */
  defaultAccountId(_cfg) {
    return DEFAULT_ACCOUNT_ID;
  },

  /**
   * Check whether the account has the required credentials configured.
   */
  isConfigured(account, _cfg) {
    return !!(account.apiKey?.trim() && account.sender?.trim());
  },

  /**
   * Explain why the account is not configured.
   */
  unconfiguredReason(account, _cfg) {
    if (!account.apiKey?.trim()) return "Missing Kudosity API key";
    if (!account.sender?.trim()) return "Missing sender number";
    return "Not configured";
  },
};

// ─── Channel Meta ────────────────────────────────────────────────────────────

const meta: ChannelMeta = {
  id: "kudosity-sms",
  label: "SMS Kudosity",
  selectionLabel: "SMS Kudosity",
  detailLabel: "SMS Kudosity",
  docsPath: "/channels/kudosity-sms",
  docsLabel: "kudosity-sms",
  blurb:
    "cloud SMS via the Kudosity API — works on any phone, no app needed. https://developers.kudosity.com",
  systemImage: "phone.badge.waveform",
};

// ─── Capabilities ────────────────────────────────────────────────────────────

const capabilities: ChannelCapabilities = {
  text: true,
  media: false, // SMS is text-only (MMS would be a separate channel)
  reactions: false,
  threads: false,
  groups: false,
  mentions: false,
  buttons: false,
  audio: false,
  video: false,
  files: false,
  location: false,
  contacts: false,
  stickers: false,
  polls: false,
  editing: false,
  deleting: false,
  forwarding: false,
  quoting: false,
  typing: false,
  readReceipts: false,
  presenceStatus: false,
};

// ─── Outbound Adapter ────────────────────────────────────────────────────────

/**
 * Sends messages from the AI assistant to the user via SMS.
 *
 * Follows the ChannelOutboundAdapter pattern used by other OpenClaw channels
 * (WhatsApp, Telegram, Slack, etc.). The gateway passes a ChannelOutboundContext
 * with { cfg, to, text, accountId, ... } and expects an OutboundDeliveryResult
 * with { channel, messageId }.
 */
const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  /**
   * Send a text message via SMS.
   *
   * @param ctx.cfg - OpenClaw config (used to resolve Kudosity credentials)
   * @param ctx.to - Recipient phone number (E.164 format)
   * @param ctx.text - Message body
   * @param ctx.accountId - Account ID (defaults to "default")
   */
  async sendText({
    cfg,
    to,
    text,
    accountId,
  }: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    [key: string]: unknown;
  }) {
    const account = configAdapter.resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const kudosityConfig: KudosityConfig = {
      apiKey: account.apiKey,
      sender: account.sender,
    };

    // Clean the recipient phone number (strip whitespace, dashes, parens)
    const cleaned = to.replace(/[\s\-\(\)]/g, "");
    if (!cleaned) {
      throw new Error("Kudosity SMS: recipient phone number is required");
    }

    const result = await sendSMS(kudosityConfig, {
      message: text,
      sender: kudosityConfig.sender,
      recipient: cleaned,
      message_ref: `openclaw-${Date.now()}`,
    });

    return {
      channel: "kudosity-sms" as const,
      messageId: result.id,
    };
  },

  /**
   * Send a media message via SMS.
   *
   * SMS is text-only, so this degrades gracefully by sending just
   * the caption text. The media URL is ignored since SMS/MMS doesn't
   * support inline media attachments via the Kudosity v2 API.
   */
  async sendMedia({
    cfg,
    to,
    text,
    accountId,
  }: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    accountId?: string | null;
    [key: string]: unknown;
  }) {
    const account = configAdapter.resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const kudosityConfig: KudosityConfig = {
      apiKey: account.apiKey,
      sender: account.sender,
    };

    const cleaned = to.replace(/[\s\-\(\)]/g, "");
    if (!cleaned) {
      throw new Error("Kudosity SMS: recipient phone number is required");
    }

    // SMS is text-only — send caption text, skip media
    const message = text?.trim() || "(media attachment — not supported via SMS)";

    const result = await sendSMS(kudosityConfig, {
      message,
      sender: kudosityConfig.sender,
      recipient: cleaned,
      message_ref: `openclaw-${Date.now()}`,
    });

    return {
      channel: "kudosity-sms" as const,
      messageId: result.id,
    };
  },
};

// ─── Plugin Export ────────────────────────────────────────────────────────────

export const kudositySmsPlugin: ChannelPlugin<KudositySmsAccount> = {
  id: "kudosity-sms",
  meta,
  capabilities,
  config: configAdapter,
  onboarding: kudositySmsOnboarding,
  outbound,

  defaults: {
    queue: {
      // SMS doesn't need debouncing — each message is independent
      debounceMs: 0,
    },
  },

  reload: {
    configPrefixes: ["kudosity-sms."],
  },
};
