import {
  mergeAllowFromEntries,
  parseSetupEntriesWithParser,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  splitSetupEntries,
} from "../../../src/channels/plugins/setup-flow-helpers.js";
import type { ChannelSetupDmPolicy } from "../../../src/channels/plugins/setup-flow-types.js";
import type { ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { DmPolicy } from "../../../src/config/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate, normalizePubkey } from "./nostr-bus.js";
import { resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;

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

function patchNostrConfig(params: {
  cfg: OpenClawConfig;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const existing = (params.cfg.channels?.nostr ?? {}) as Record<string, unknown>;
  const nextNostr = { ...existing };
  for (const field of params.clearFields ?? []) {
    delete nextNostr[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      nostr: {
        ...nextNostr,
        ...(params.enabled ? { enabled: true } : {}),
        ...params.patch,
      },
    },
  };
}

function setNostrDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel,
    dmPolicy,
  });
}

function setNostrAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  return setTopLevelChannelAllowFrom({
    cfg,
    channel,
    allowFrom,
  });
}

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
  const existing = params.cfg.channels?.nostr?.allowFrom ?? [];
  await params.prompter.note(NOSTR_ALLOW_FROM_HELP_LINES.join("\n"), "Nostr allowlist");
  const entry = await params.prompter.text({
    message: "Nostr allowFrom",
    placeholder: "npub1..., 0123abcd...",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      return parseNostrAllowFrom(raw).error;
    },
  });
  const parsed = parseNostrAllowFrom(String(entry));
  return setNostrAllowFrom(params.cfg, mergeAllowFromEntries(existing, parsed.entries));
}

const nostrDmPolicy: ChannelSetupDmPolicy = {
  label: "Nostr",
  channel,
  policyKey: "channels.nostr.dmPolicy",
  allowFromKey: "channels.nostr.allowFrom",
  getCurrent: (cfg) => cfg.channels?.nostr?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setNostrDmPolicy(cfg, policy),
  promptAllowFrom: promptNostrAllowFrom,
};

export const nostrSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountName: ({ cfg, name }) =>
    patchNostrConfig({
      cfg,
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
    return patchNostrConfig({
      cfg,
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
      patchNostrConfig({
        cfg,
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
        patchNostrConfig({
          cfg,
          enabled: true,
          clearFields: ["privateKey"],
          patch: {},
        }),
      applySet: async ({ cfg, resolvedValue }) =>
        patchNostrConfig({
          cfg,
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
        return patchNostrConfig({
          cfg,
          enabled: true,
          clearFields: relayResult.relays.length > 0 ? undefined : ["relays"],
          patch: relayResult.relays.length > 0 ? { relays: relayResult.relays } : {},
        });
      },
    },
  ],
  dmPolicy: nostrDmPolicy,
  disable: (cfg) =>
    patchNostrConfig({
      cfg,
      patch: { enabled: false },
    }),
};
