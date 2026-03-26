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
} from "openclaw/plugin-sdk/kudosity-sms";
import { sendSMS, type KudosityConfig } from "./kudosity-api.js";
import { getKudositySmsRuntime } from "./runtime.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** E.164-ish phone number pattern: optional +, then 7–15 digits starting with non-zero. */
const E164_RE = /^\+?[1-9]\d{6,14}$/;

/**
 * Clean and validate a phone number for outbound SMS.
 * Strips whitespace, dashes, parens, and dots, then checks E.164 format.
 */
function cleanPhoneNumber(raw: string, fieldName = "recipient"): string {
  const cleaned = raw.replace(/[\s\-\(\)\.]/g, "");
  if (!cleaned) {
    throw new Error(`Kudosity SMS: ${fieldName} phone number is required`);
  }
  if (!E164_RE.test(cleaned)) {
    throw new Error(
      `Kudosity SMS: invalid phone number format "${cleaned}" — expected E.164 (e.g. +61400000000)`,
    );
  }
  return cleaned;
}

/** Generate a unique, collision-resistant message reference. */
function generateMessageRef(): string {
  return `openclaw-${crypto.randomUUID()}`;
}

// ─── Config Types ────────────────────────────────────────────────────────────

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_KEY = "kudosity-sms";

export interface KudositySmsAccount {
  accountId: string;
  apiKey: string;
  sender: string;
  enabled?: boolean;
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
   * Reads API key and sender from nested config or env vars.
   */
  resolveAccount(cfg, _accountId) {
    const section = (cfg as Record<string, any>).channels?.[CHANNEL_KEY];
    const apiKey = String(section?.apiKey ?? process.env.KUDOSITY_API_KEY ?? "").trim();
    const sender = String(section?.sender ?? process.env.KUDOSITY_SENDER ?? "").trim();
    const enabled = section?.enabled as boolean | undefined;
    return { accountId: DEFAULT_ACCOUNT_ID, apiKey, sender, enabled };
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
  chatTypes: ["direct"],
};

// ─── Config Schema ───────────────────────────────────────────────────────────

/**
 * Channel-level config schema for `channels.kudosity-sms`.
 *
 * This is consumed by `loadSchemaWithPlugins` / `applyChannelSchemas` so the
 * Control UI and schema-driven config flows can render and validate the
 * Kudosity credential fields. The plugin manifest (`openclaw.plugin.json`)
 * intentionally keeps an empty schema because it validates plugin-entry scope,
 * not channel scope.
 */
const configSchema = {
  schema: {
    type: "object" as const,
    properties: {
      apiKey: {
        type: "string" as const,
        description: "Kudosity API key for authenticating requests",
      },
      sender: {
        type: "string" as const,
        description: "Default sender number (E.164 format, e.g. +61400000000)",
      },
    },
    // No `required` — the disable flow removes these fields (keeping only `enabled: false`),
    // and env-backed setups never populate them. Readiness is enforced by `isConfigured()`.
  },
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
    const cleanedSender = cleanPhoneNumber(account.sender, "sender");
    const kudosityConfig: KudosityConfig = {
      apiKey: account.apiKey,
      sender: cleanedSender,
    };

    const cleaned = cleanPhoneNumber(to);

    const result = await sendSMS(kudosityConfig, {
      message: text,
      sender: cleanedSender,
      recipient: cleaned,
      message_ref: generateMessageRef(),
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
    mediaUrl,
    accountId,
  }: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    accountId?: string | null;
    [key: string]: unknown;
  }) {
    if (mediaUrl) {
      getKudositySmsRuntime()
        .logging.getChildLogger({ plugin: "kudosity-sms" })
        .warn(
          "Kudosity SMS: media attachments are not supported via SMS — sending text only. " +
            "Dropped media URL (redacted).",
        );
    }

    const account = configAdapter.resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const cleanedSender = cleanPhoneNumber(account.sender, "sender");
    const kudosityConfig: KudosityConfig = {
      apiKey: account.apiKey,
      sender: cleanedSender,
    };

    const cleaned = cleanPhoneNumber(to);

    // SMS is text-only — send caption text, skip media
    const message = text?.trim() || "The assistant sent a file that can't be delivered via SMS.";

    const result = await sendSMS(kudosityConfig, {
      message,
      sender: cleanedSender,
      recipient: cleaned,
      message_ref: generateMessageRef(),
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
  configSchema,
  config: configAdapter,
  // TODO: Convert onboarding.ts ChannelSetupWizardAdapter to declarative
  // ChannelSetupWizard format and wire it here as `setupWizard`. The imperative
  // adapter exists in onboarding.ts but the plugin type requires the declarative
  // shape (status, credentials, textInputs, etc.). See BlueBubbles/Telegram
  // setup-surface.ts for reference. Until then, `openclaw setup` will not
  // list this channel in guided setup — outbound SMS still works.
  outbound,

  defaults: {
    queue: {
      // SMS doesn't need debouncing — each message is independent
      debounceMs: 0,
    },
  },

  reload: {
    configPrefixes: ["channels.kudosity-sms"],
  },
};
