import { setSetupChannelEnabled, type ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { detectBinary, installSignalCli } from "openclaw/plugin-sdk/signal";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import {
  createSignalCliPathTextInput,
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  signalCompletionNote,
  signalDmPolicy,
  signalNumberTextInput,
  signalSetupAdapter,
} from "./setup-core.js";

const channel = "signal" as const;

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
    createSignalCliPathTextInput(async ({ currentValue }) => {
      return !(await detectBinary(currentValue ?? "signal-cli"));
    }),
    signalNumberTextInput,
  ],
  completionNote: signalCompletionNote,
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { normalizeSignalAccountInput, parseSignalAllowFromEntries, signalSetupAdapter };
