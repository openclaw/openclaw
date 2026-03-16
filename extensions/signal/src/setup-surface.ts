import type { ChannelOnboardingDmPolicy } from "../../../src/channels/plugins/onboarding-types.js";
import {
  parseOnboardingEntriesAllowingWildcard,
  promptParsedAllowFromForScopedChannel,
  setChannelDmPolicyWithAllowFrom,
  setOnboardingChannelEnabled,
} from "../../../src/channels/plugins/onboarding/helpers.js";
import { type ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { formatCliCommand } from "../../../src/cli/command-format.js";
import { detectBinary } from "../../../src/commands/onboard-helpers.js";
import { installSignalCli } from "../../../src/commands/signal-install.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
import {
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  signalSetupAdapter,
} from "./setup-core.js";

const channel = "signal" as const;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

async function promptSignalAllowFrom(params: {
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

const signalDmPolicy: ChannelOnboardingDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  getCurrent: (cfg) => cfg.channels?.signal?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setChannelDmPolicyWithAllowFrom({
      cfg,
      channel,
      dmPolicy: policy,
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

export const signalSetupWizard: ChannelSetupWizard = {
  channel,
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
    resolveStatusLines: async ({ cfg, configured }) => {
      const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
      const signalCliDetected = await detectBinary(signalCliPath);
      return [
        `Signal: ${configured ? "configured" : "needs setup"}`,
        `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`,
      ];
    },
    resolveSelectionHint: async ({ cfg }) => {
      const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
      return (await detectBinary(signalCliPath)) ? "signal-cli found" : "signal-cli missing";
    },
    resolveQuickstartScore: async ({ cfg }) => {
      const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
      return (await detectBinary(signalCliPath)) ? 1 : 0;
    },
  },
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowSignalInstall) {
      return;
    }
    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ cfg, accountId }).config.cliPath ??
      "signal-cli";
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await prompter.confirm({
      message: cliDetected
        ? "signal-cli detected. Reinstall/update now?"
        : "signal-cli not found. Install now?",
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return;
    }
    try {
      const result = await installSignalCli(runtime);
      if (result.ok && result.cliPath) {
        await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        return {
          credentialValues: {
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
      }
    } catch (error) {
      await prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
    }
  },
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
      shouldPrompt: async ({ currentValue }) => !(await detectBinary(currentValue ?? "signal-cli")),
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
      `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
  },
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};

export { normalizeSignalAccountInput, parseSignalAllowFromEntries, signalSetupAdapter };
