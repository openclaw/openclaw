import {
  detectBinary,
  installSignalCli,
  type OpenClawConfig,
} from "../../../src/plugin-sdk-internal/setup.js";
import type { ChannelSetupWizard } from "../../../src/plugin-sdk-internal/setup.js";
import { resolveSignalAccount } from "./accounts.js";
import {
  createSignalSetupWizardBase,
  INVALID_SIGNAL_ACCOUNT_ERROR,
  normalizeSignalAccountInput,
  promptSignalAllowFrom,
  signalSetupAdapter,
} from "./setup-core.js";

export const signalSetupWizard: ChannelSetupWizard = createSignalSetupWizardBase({
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
  shouldPromptCliPath: async ({ currentValue }) =>
    !(await detectBinary(currentValue ?? "signal-cli")),
});

export {
  INVALID_SIGNAL_ACCOUNT_ERROR,
  normalizeSignalAccountInput,
  promptSignalAllowFrom,
  signalSetupAdapter,
};
