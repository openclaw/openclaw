/**
 * Declarative setup wizard for the Kudosity SMS channel.
 *
 * This implements the `ChannelSetupWizard` contract consumed by
 * `openclaw setup` so the channel appears in guided setup. The wizard
 * uses an empty `credentials` list and does the interactive API-key /
 * sender prompting inside `finalize`, because the declarative
 * credential keys (`ChannelSetupInput`) don't include a good match for
 * "API key + E.164 sender" without re-purposing unrelated fields.
 */

import {
  createStandardChannelSetupStatus,
  formatDocsLink,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { validateApiKey, type KudosityConfig } from "./kudosity-api.js";
import type { OpenClawConfig } from "./runtime-api.js";

const channel = "kudosity-sms" as const;
const CHANNEL_KEY = "kudosity-sms";

interface KudositySmsChannelConfig {
  apiKey?: string;
  sender?: string;
  enabled?: boolean;
}

interface ConfigWithChannels {
  channels?: Record<string, KudositySmsChannelConfig | undefined>;
  [key: string]: unknown;
}

function getChannelSection(cfg: OpenClawConfig): KudositySmsChannelConfig {
  return (cfg as ConfigWithChannels).channels?.[CHANNEL_KEY] ?? {};
}

function getApiKey(cfg: OpenClawConfig): string {
  return (getChannelSection(cfg).apiKey ?? process.env.KUDOSITY_API_KEY ?? "").trim();
}

function getSender(cfg: OpenClawConfig): string {
  return (getChannelSection(cfg).sender ?? process.env.KUDOSITY_SENDER ?? "").trim();
}

function isKudositySmsConfigured(cfg: OpenClawConfig): boolean {
  return Boolean(getApiKey(cfg) && getSender(cfg));
}

const SETUP_HELP_LINES = [
  "1) Sign up at https://kudosity.com/signup (free trial available)",
  "2) Get an API key from Settings -> API Keys -> Create Key",
  "3) Lease a sender number from Numbers -> Lease a virtual number",
  `Docs: ${formatDocsLink("/channels/kudosity-sms", "channels/kudosity-sms")}`,
];

/** E.164-ish sender validation shared with the outbound cleaner in channel.ts. */
const E164_RE = /^\+?[1-9]\d{6,14}$/;

function cleanSender(value: string): string {
  return value.replace(/[\s\-()]/g, "");
}

export const kudositySmsSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "SMS Kudosity",
    configuredLabel: "configured",
    unconfiguredLabel: "needs API key + sender",
    configuredHint: "configured",
    unconfiguredHint: "needs API key + sender",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isKudositySmsConfigured(cfg),
    resolveExtraStatusLines: ({ cfg, configured }) => {
      if (!configured) {
        return [];
      }
      const sender = getSender(cfg);
      return sender ? [`Sender: ${sender}`] : [];
    },
  }),
  introNote: {
    title: "Kudosity SMS setup",
    lines: SETUP_HELP_LINES,
    shouldShow: ({ cfg }) => !isKudositySmsConfigured(cfg),
  },
  credentials: [],
  finalize: async ({ cfg, prompter }) => {
    // Step 1: API key
    const existingApiKey = getApiKey(cfg);
    const apiKeyInput = await prompter.text({
      message: "Enter your Kudosity API key:",
      initialValue: existingApiKey || undefined,
      placeholder: "Your Kudosity API key",
      validate: (value: string) => {
        if (!value || !value.trim()) {
          return "API key is required. Get one at https://kudosity.com -> Settings -> API Keys";
        }
        return undefined;
      },
    });

    if (apiKeyInput === undefined || apiKeyInput === null) {
      // User cancelled — return the existing cfg unchanged so finalize has a
      // consistent return shape (the framework treats the returned `cfg` as the
      // next cfg and falls through for an absent `credentialValues`).
      return { cfg };
    }

    const apiKey = apiKeyInput.trim();

    // Step 2: validate API key against the Kudosity API
    await prompter.note("Validating API key...", "Validation");
    const validationConfig: KudosityConfig = { apiKey, sender: "" };
    const isValid = await validateApiKey(validationConfig);

    if (!isValid) {
      await prompter.note(
        "API key validation failed. Please check your key and try again.\n" +
          "Get a key at https://kudosity.com -> Settings -> API Keys",
        "Validation Failed",
      );
      return { cfg };
    }

    await prompter.note("API key is valid.", "Validation");

    // Step 3: sender number
    const existingSender = getSender(cfg);
    const senderInput = await prompter.text({
      message: "Enter your sender number (E.164 format, e.g. +61400000000):",
      initialValue: existingSender || undefined,
      placeholder: "+61400000000",
      validate: (value: string) => {
        if (!value || !value.trim()) {
          return "Sender number is required. Lease one at https://kudosity.com -> Numbers";
        }
        const cleaned = cleanSender(value);
        if (!E164_RE.test(cleaned)) {
          return "Invalid phone number format. Use E.164 format (e.g. +61400000000)";
        }
        return undefined;
      },
    });

    if (senderInput === undefined || senderInput === null) {
      return { cfg };
    }

    const sender = cleanSender(senderInput);

    // Step 4: persist
    const prev = cfg as ConfigWithChannels;
    const next = {
      ...prev,
      channels: {
        ...prev.channels,
        [CHANNEL_KEY]: {
          ...prev.channels?.[CHANNEL_KEY],
          enabled: true,
          apiKey,
          sender,
        },
      },
    } as unknown as OpenClawConfig;

    await prompter.note(
      `Kudosity SMS channel configured.\nSender: ${sender}\n\n` +
        "Your AI assistant can now send SMS messages.\n" +
        "Inbound SMS support is planned for a future release.",
      "Success",
    );

    return { cfg: next };
  },
  disable: (cfg) => {
    const prev = cfg as ConfigWithChannels;
    const section: KudositySmsChannelConfig = { ...prev.channels?.[CHANNEL_KEY] };
    delete section.apiKey;
    delete section.sender;
    section.enabled = false;
    return {
      ...prev,
      channels: {
        ...prev.channels,
        [CHANNEL_KEY]: section,
      },
    } as unknown as OpenClawConfig;
  },
};
