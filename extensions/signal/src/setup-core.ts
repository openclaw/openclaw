import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeE164,
  parseSetupEntriesAllowingWildcard,
  promptParsedAllowFromForScopedChannel,
  setChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  type OpenClawConfig,
  type WizardPrompter,
} from "../../../src/plugin-sdk-internal/setup.js";
import type {
  ChannelSetupAdapter,
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
} from "../../../src/plugin-sdk-internal/setup.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
export const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (entry.toLowerCase().startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
  };
}

export async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForScopedChannel({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: "Signal allowlist",
    noteLines: [
      "Allowlist Signal DMs by sender id.",
      "Examples:",
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: "Signal allowFrom (E.164 or uuid)",
    placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
  });
}

export const signalSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ input }) => {
    if (
      !input.signalNumber &&
      !input.httpUrl &&
      !input.httpHost &&
      !input.httpPort &&
      !input.cliPath
    ) {
      return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          signal: {
            ...next.channels?.signal,
            enabled: true,
            ...buildSignalSetupPatch(input),
          },
        },
      };
    }
    return {
      ...next,
      channels: {
        ...next.channels,
        signal: {
          ...next.channels?.signal,
          enabled: true,
          accounts: {
            ...next.channels?.signal?.accounts,
            [accountId]: {
              ...next.channels?.signal?.accounts?.[accountId],
              enabled: true,
              ...buildSignalSetupPatch(input),
            },
          },
        },
      },
    };
  },
};

type SignalSetupWizardHandlers = {
  resolveStatusLines: NonNullable<ChannelSetupWizard["status"]>["resolveStatusLines"];
  resolveSelectionHint: NonNullable<ChannelSetupWizard["status"]>["resolveSelectionHint"];
  resolveQuickstartScore: NonNullable<ChannelSetupWizard["status"]>["resolveQuickstartScore"];
  prepare?: ChannelSetupWizard["prepare"];
  shouldPromptCliPath: NonNullable<
    NonNullable<ChannelSetupWizard["textInputs"]>[number]["shouldPrompt"]
  >;
};

export function createSignalSetupWizardBase(
  handlers: SignalSetupWizardHandlers,
): ChannelSetupWizard {
  const setupChannel = "signal" as const;
  const signalDmPolicy: ChannelSetupDmPolicy = {
    label: "Signal",
    channel: setupChannel,
    policyKey: "channels.signal.dmPolicy",
    allowFromKey: "channels.signal.allowFrom",
    getCurrent: (cfg: OpenClawConfig) => cfg.channels?.signal?.dmPolicy ?? "pairing",
    setPolicy: (cfg: OpenClawConfig, policy) =>
      setChannelDmPolicyWithAllowFrom({
        cfg,
        channel: setupChannel,
        dmPolicy: policy,
      }),
    promptAllowFrom: promptSignalAllowFrom,
  };

  return {
    channel: setupChannel,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      configuredHint: "signal-cli found",
      unconfiguredHint: "signal-cli missing",
      configuredScore: 1,
      unconfiguredScore: 0,
      resolveConfigured: ({ cfg }) =>
        listSignalAccountIds(cfg).some(
          (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
        ),
      resolveStatusLines: handlers.resolveStatusLines,
      resolveSelectionHint: handlers.resolveSelectionHint,
      resolveQuickstartScore: handlers.resolveQuickstartScore,
    },
    prepare: handlers.prepare,
    credentials: [],
    textInputs: [
      {
        inputKey: "cliPath",
        message: "signal-cli path",
        currentValue: ({ cfg, accountId, credentialValues }) =>
          (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
          resolveSignalAccount({ cfg, accountId }).config.cliPath ??
          "signal-cli",
        initialValue: ({ cfg, accountId, credentialValues }) =>
          (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
          resolveSignalAccount({ cfg, accountId }).config.cliPath ??
          "signal-cli",
        shouldPrompt: handlers.shouldPromptCliPath,
        confirmCurrentValue: false,
        applyCurrentValue: true,
        helpTitle: "Signal",
        helpLines: [
          "signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.",
        ],
      },
      {
        inputKey: "signalNumber",
        message: "Signal bot number (E.164)",
        currentValue: ({ cfg, accountId }) =>
          normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
          undefined,
        keepPrompt: (value) => `Signal account set (${value}). Keep it?`,
        validate: ({ value }) =>
          normalizeSignalAccountInput(value) ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
        normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
      },
    ],
    completionNote: {
      title: "Signal next steps",
      lines: [
        'Link device with: signal-cli link -n "OpenClaw"',
        "Scan QR in Signal -> Linked Devices",
        `Then run: openclaw gateway call channels.status --params '{"probe":true}'`,
        "Docs: https://docs.openclaw.ai/signal",
      ],
    },
    dmPolicy: signalDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, setupChannel, false),
  } satisfies ChannelSetupWizard;
}

export function createSignalSetupWizardProxy(
  loadWizard: () => Promise<{ signalSetupWizard: ChannelSetupWizard }>,
) {
  return createSignalSetupWizardBase({
    resolveStatusLines: async (params) =>
      (await loadWizard()).signalSetupWizard.status.resolveStatusLines?.(params) ?? [],
    resolveSelectionHint: async (params) =>
      await (await loadWizard()).signalSetupWizard.status.resolveSelectionHint?.(params),
    resolveQuickstartScore: async (params) =>
      await (await loadWizard()).signalSetupWizard.status.resolveQuickstartScore?.(params),
    prepare: async (params) => await (await loadWizard()).signalSetupWizard.prepare?.(params),
    shouldPromptCliPath: async (params) => {
      const input = (await loadWizard()).signalSetupWizard.textInputs?.find(
        (entry) => entry.inputKey === "cliPath",
      );
      return (await input?.shouldPrompt?.(params)) ?? false;
    },
  });
}
