/**
 * Kudosity SMS onboarding wizard for OpenClaw.
 *
 * Guides users through creating a Kudosity account, getting an API key,
 * and configuring a sender number. Follows the same patterns used by
 * Telegram, Slack, and other channel onboarding adapters.
 */

import type { ChannelSetupWizardAdapter } from "openclaw/plugin-sdk/kudosity-sms";
import { validateApiKey, type KudosityConfig } from "./kudosity-api.js";

const CHANNEL_ID = "kudosity-sms";
const CHANNEL_KEY = "kudosity-sms";
const DEFAULT_ACCOUNT_ID = "default";

// ─── Config Shape ────────────────────────────────────────────────────────────

/** Narrow type for the Kudosity SMS section within OpenClaw's config. */
interface KudositySmsChannelConfig {
  apiKey?: string;
  sender?: string;
  enabled?: boolean;
}

/** OpenClaw config with optional nested channel structure. */
interface ConfigWithChannels {
  channels?: Record<string, KudositySmsChannelConfig | undefined>;
  [key: string]: unknown;
}

// ─── Status Check ────────────────────────────────────────────────────────────

function getChannelSection(cfg: unknown): KudositySmsChannelConfig {
  return (cfg as ConfigWithChannels)?.channels?.[CHANNEL_KEY] ?? {};
}

function getApiKey(cfg: unknown): string {
  return String(getChannelSection(cfg)?.apiKey ?? process.env.KUDOSITY_API_KEY ?? "").trim();
}

function getSender(cfg: unknown): string {
  return String(getChannelSection(cfg)?.sender ?? process.env.KUDOSITY_SENDER ?? "").trim();
}

// ─── Onboarding Adapter ──────────────────────────────────────────────────────

export const kudositySmsOnboarding: ChannelSetupWizardAdapter = {
  channel: CHANNEL_ID,

  /**
   * Check if the Kudosity SMS channel is already configured.
   *
   * Returns ChannelOnboardingStatus with required fields:
   * - channel: the channel ID
   * - configured: whether the channel is ready to use
   * - statusLines: human-readable status for the CLI display
   * - selectionHint: short hint shown in channel selector
   */
  async getStatus(ctx) {
    const apiKey = getApiKey(ctx.cfg);
    const sender = getSender(ctx.cfg);

    if (apiKey && sender) {
      return {
        channel: CHANNEL_ID,
        configured: true,
        statusLines: [`SMS Kudosity: configured (sender: ${sender})`],
        selectionHint: "configured",
      };
    }

    if (apiKey && !sender) {
      return {
        channel: CHANNEL_ID,
        configured: false,
        statusLines: ["SMS Kudosity: API key set but sender number missing"],
        selectionHint: "needs sender number",
      };
    }

    return {
      channel: CHANNEL_ID,
      configured: false,
      statusLines: ["SMS Kudosity: not configured"],
      selectionHint: "not configured",
    };
  },

  /**
   * Interactive CLI wizard to configure Kudosity SMS.
   *
   * Guides the user through:
   * 1. Signing up for a Kudosity account
   * 2. Getting an API key
   * 3. Getting a sender number
   * 4. Validating the connection
   *
   * Must always return ChannelOnboardingResult { cfg, accountId? }.
   * If the user cancels, returns the unchanged cfg.
   */
  async configure(ctx) {
    const { prompter, cfg } = ctx;

    // Show setup instructions
    await prompter.note(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📱 Kudosity SMS Channel Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  To use SMS with OpenClaw, you need a Kudosity account.

  📋 Step 1: Sign up at https://kudosity.com/signup
     (Free trial available)

  📋 Step 2: Get your API key from the dashboard
     → Settings → API Keys → Create Key

  📋 Step 3: Get a sender number
     → Numbers → Lease a virtual number
     → Or use an existing number on your account

  📚 API Docs: https://developers.kudosity.com
  📚 MCP Server: https://developers.kudosity.com/mcp

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      "Kudosity SMS Setup",
    );

    // Prompt for API key
    const existingApiKey = getApiKey(cfg);
    const apiKey = await prompter.text({
      message: "Enter your Kudosity API key:",
      initialValue: existingApiKey ?? undefined,
      placeholder: "Your Kudosity API key",
      validate: (value: string) => {
        if (!value || value.trim().length === 0) {
          return "API key is required. Get one at https://kudosity.com → Settings → API Keys";
        }
        return undefined;
      },
    });

    if (!apiKey) {
      // User cancelled — return unchanged config
      return { cfg };
    }

    // Validate the API key
    await prompter.note("🔄 Validating API key...", "Validation");
    const config: KudosityConfig = { apiKey: apiKey.trim(), sender: "" };
    const isValid = await validateApiKey(config);

    if (!isValid) {
      await prompter.note(
        "❌ API key validation failed. Please check your key and try again.\n" +
          "   Get a key at: https://kudosity.com → Settings → API Keys",
        "Validation Failed",
      );
      // Return unchanged config on validation failure
      return { cfg };
    }

    await prompter.note("✅ API key is valid!", "Validation");

    // Prompt for sender number
    const existingSender = getSender(cfg);
    const sender = await prompter.text({
      message: "Enter your sender number (E.164 format, e.g. +61400000000):",
      initialValue: existingSender ?? undefined,
      placeholder: "+61400000000",
      validate: (value: string) => {
        if (!value || value.trim().length === 0) {
          return "Sender number is required. Lease one at https://kudosity.com → Numbers";
        }
        // Basic E.164 validation
        const cleaned = value.trim().replace(/[\s\-\(\)]/g, "");
        if (!/^\+?[1-9]\d{6,14}$/.test(cleaned)) {
          return "Invalid phone number format. Use E.164 format (e.g. +61400000000)";
        }
        return undefined;
      },
    });

    if (!sender) {
      // User cancelled — return unchanged config
      return { cfg };
    }

    await prompter.note(
      `✅ Kudosity SMS channel configured!
   Sender: ${sender.trim()}

   Your AI assistant can now send SMS messages.
   Inbound SMS support is planned for a future release.`,
      "Success",
    );

    // Return the full updated config object with nested channel structure
    const prev = cfg as ConfigWithChannels;
    const next = {
      ...prev,
      channels: {
        ...prev.channels,
        [CHANNEL_KEY]: {
          ...prev.channels?.[CHANNEL_KEY],
          enabled: true,
          apiKey: apiKey.trim(),
          sender: sender.trim().replace(/[\s\-\(\)]/g, ""),
        },
      },
    };

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  // dmPolicy is intentionally omitted — SMS is inherently 1:1 and uses
  // the default pairing policy. The full ChannelOnboardingDmPolicy interface
  // requires getCurrent/setPolicy/policyKey/allowFromKey which are not needed
  // for a simple single-account SMS channel.

  /**
   * Disable the Kudosity SMS channel by removing config keys.
   */
  disable(cfg: unknown) {
    const prev = cfg as ConfigWithChannels;
    const section = { ...prev.channels?.[CHANNEL_KEY] };
    delete section.apiKey;
    delete section.sender;
    section.enabled = false;
    return {
      ...prev,
      channels: {
        ...prev.channels,
        [CHANNEL_KEY]: section,
      },
    };
  },
};
