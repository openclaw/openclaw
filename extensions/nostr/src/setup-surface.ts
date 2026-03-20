import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import {
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  mergeAllowFromEntries,
  parseSetupEntriesWithParser,
  patchTopLevelChannelConfigSection,
  promptParsedAllowFromForAccount,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupDmPolicy } from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate, normalizePubkey } from "./nostr-bus.js";
import { resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;
const setNostrAllowFrom = createTopLevelChannelAllowFromSetter({
  channel,
});

const NOSTR_SETUP_HELP_LINES = [
  "Use a Nostr private key in nsec or 64-character hex format.",
  "Relay URLs are optional. Leave blank to keep the default relay set.",
  "Env vars supported: NOSTR_PRIVATE_KEY (default account only).",
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

const NOSTR_ALLOW_FROM_HELP_LINES = [
  "Allowlist Nostr DMs by npub or hex pubkey.",
  "Examples:",
  "- npub1...",
  "- nostr:npub1...",
  "- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

function parseRelayUrls(raw: string): { relays: string[]; error?: string } {
  const entries = splitSetupEntries(raw);
  const relays: string[] = [];
  for (const entry of entries) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { relays: [], error: `Relay must use ws:// or wss:// (${entry})` };
      }
    } catch {
      return { relays: [], error: `Invalid relay URL: ${entry}` };
    }
    relays.push(entry);
  }
  return { relays: [...new Set(relays)] };
}

function parseNostrAllowFrom(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesWithParser(raw, (entry) => {
    const cleaned = entry.replace(/^nostr:/i, "").trim();
    try {
      return { value: normalizePubkey(cleaned) };
    } catch {
      return { error: `Invalid Nostr pubkey: ${entry}` };
    }
  });
}

async function promptNostrAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  return await promptParsedAllowFromForAccount({
    cfg: params.cfg,
    defaultAccountId: DEFAULT_ACCOUNT_ID,
    prompter: params.prompter,
    noteTitle: "Nostr allowlist",
    noteLines: NOSTR_ALLOW_FROM_HELP_LINES,
    message: "Nostr allowFrom",
    placeholder: "npub1..., 0123abcd...",
    parseEntries: parseNostrAllowFrom,
    getExistingAllowFrom: ({ cfg }) => cfg.channels?.nostr?.allowFrom ?? [],
    mergeEntries: ({ existing, parsed }) => mergeAllowFromEntries(existing, parsed),
    applyAllowFrom: ({ cfg, allowFrom }) => setNostrAllowFrom(cfg, allowFrom),
  });
}

const nostrDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "Nostr",
  channel,
  policyKey: "channels.nostr.dmPolicy",
  allowFromKey: "channels.nostr.allowFrom",
  getCurrent: (cfg) => cfg.channels?.nostr?.dmPolicy ?? "pairing",
  promptAllowFrom: promptNostrAllowFrom,
});

export const nostrSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountName: ({ cfg, name }) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: ({ input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      privateKey?: string;
      relayUrls?: string;
    };
    if (!typedInput.useEnv) {
      const privateKey = typedInput.privateKey?.trim();
      if (!privateKey) {
        return "Nostr requires --private-key or --use-env.";
      }
      try {
        getPublicKeyFromPrivate(privateKey);
      } catch {
        return "Nostr private key must be valid nsec or 64-character hex.";
      }
    }
    if (typedInput.relayUrls?.trim()) {
      return parseRelayUrls(typedInput.relayUrls).error ?? null;
    }
    return null;
  },
  applyAccountConfig: ({ cfg, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      privateKey?: string;
      relayUrls?: string;
    };
    const relayResult = typedInput.relayUrls?.trim()
      ? parseRelayUrls(typedInput.relayUrls)
      : { relays: [] };
    return patchTopLevelChannelConfigSection({
      cfg,
      channel,
      enabled: true,
      clearFields: typedInput.useEnv ? ["privateKey"] : undefined,
      patch: {
        ...(typedInput.useEnv ? {} : { privateKey: typedInput.privateKey?.trim() }),
        ...(relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}),
      },
    });
  },
};

export const nostrSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs private key",
    configuredHint: "configured",
    unconfiguredHint: "needs private key",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => resolveNostrAccount({ cfg }).configured,
    resolveStatusLines: ({ cfg, configured }) => {
      const account = resolveNostrAccount({ cfg });
      return [
        `Nostr: ${configured ? "configured" : "needs private key"}`,
        `Relays: ${account.relays.length || DEFAULT_RELAYS.length}`,
      ];
    },
  },
  introNote: {
    title: "Nostr setup",
    lines: NOSTR_SETUP_HELP_LINES,
  },
  envShortcut: {
    prompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
    preferredEnvVar: "NOSTR_PRIVATE_KEY",
    isAvailable: ({ cfg, accountId }) =>
      accountId === DEFAULT_ACCOUNT_ID &&
      Boolean(process.env.NOSTR_PRIVATE_KEY?.trim()) &&
      !resolveNostrAccount({ cfg, accountId }).config.privateKey?.trim(),
    apply: async ({ cfg }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        enabled: true,
        clearFields: ["privateKey"],
        patch: {},
      }),
  },
  credentials: [
    {
      inputKey: "privateKey",
      providerHint: channel,
      credentialLabel: "private key",
      preferredEnvVar: "NOSTR_PRIVATE_KEY",
      helpTitle: "Nostr private key",
      helpLines: NOSTR_SETUP_HELP_LINES,
      envPrompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
      keepPrompt: "Nostr private key already configured. Keep it?",
      inputPrompt: "Nostr private key (nsec... or hex)",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: Boolean(account.config.privateKey?.trim()),
          resolvedValue: account.config.privateKey?.trim(),
          envValue: process.env.NOSTR_PRIVATE_KEY?.trim(),
        };
      },
      applyUseEnv: async ({ cfg }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: ["privateKey"],
          patch: {},
        }),
      applySet: async ({ cfg, resolvedValue }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: { privateKey: resolvedValue },
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "relayUrls",
      message: "Relay URLs (comma-separated, optional)",
      placeholder: DEFAULT_RELAYS.join(", "),
      required: false,
      applyEmptyValue: true,
      helpTitle: "Nostr relays",
      helpLines: ["Use ws:// or wss:// relay URLs.", "Leave blank to keep the default relay set."],
      currentValue: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        const relays =
          cfg.channels?.nostr?.relays && cfg.channels.nostr.relays.length > 0 ? account.relays : [];
        return relays.join(", ");
      },
      keepPrompt: (value) => `Relay URLs set (${value}). Keep them?`,
      validate: ({ value }) => parseRelayUrls(value).error,
      applySet: async ({ cfg, value }) => {
        const relayResult = parseRelayUrls(value);
        return patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: relayResult.relays.length > 0 ? undefined : ["relays"],
          patch: relayResult.relays.length > 0 ? { relays: relayResult.relays } : {},
        });
      },
    },
  ],
  dmPolicy: nostrDmPolicy,
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};
