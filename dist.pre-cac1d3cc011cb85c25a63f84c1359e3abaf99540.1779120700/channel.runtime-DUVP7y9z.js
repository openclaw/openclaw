import { t as createSetupTranslator } from "./i18n-rRyaHfOB.js";
import { t as detectBinary } from "./detect-binary-XL0HMrQT.js";
import { J as setSetupChannelEnabled } from "./setup-wizard-helpers-Zsn8kxPS.js";
import { l as createDetectedBinaryStatus } from "./setup-wizard-proxy-CGwXbi63.js";
import "./setup-CfFOPCI5.js";
import "./setup-tools-BRfafuRU.js";
import { i as resolveSignalAccount, n as listSignalAccountIds } from "./accounts-DKDSqJbi.js";
import { a as signalDmPolicy, i as signalCompletionNote, o as signalNumberTextInput, t as createSignalCliPathTextInput } from "./setup-core-BMiUPLnh.js";
import { r as installSignalCli } from "./install-signal-cli-DgD1jYGf.js";
//#region extensions/signal/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "signal";
//#endregion
//#region extensions/signal/src/channel.runtime.ts
const signalSetupWizard = {
	channel,
	status: createDetectedBinaryStatus({
		channelLabel: "Signal",
		binaryLabel: "signal-cli",
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
		configuredHint: t("wizard.channels.statusSignalCliFound"),
		unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg, accountId }) => accountId ? resolveSignalAccount({
			cfg,
			accountId
		}).configured : listSignalAccountIds(cfg).some((resolvedAccountId) => resolveSignalAccount({
			cfg,
			accountId: resolvedAccountId
		}).configured),
		resolveBinaryPath: ({ cfg, accountId }) => resolveSignalAccount({
			cfg,
			accountId
		}).config.cliPath ?? "signal-cli",
		detectBinary
	}),
	prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
		if (!options?.allowSignalInstall) return;
		const cliDetected = await detectBinary((typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : void 0) ?? resolveSignalAccount({
			cfg,
			accountId
		}).config.cliPath ?? "signal-cli");
		if (!await prompter.confirm({
			message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
			initialValue: !cliDetected
		})) return;
		try {
			const result = await installSignalCli(runtime);
			if (result.ok && result.cliPath) {
				await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
				return { credentialValues: { cliPath: result.cliPath } };
			}
			if (!result.ok) await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
		} catch (error) {
			await prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
		}
	},
	credentials: [],
	textInputs: [createSignalCliPathTextInput(async ({ currentValue }) => {
		return !await detectBinary(currentValue ?? "signal-cli");
	}), signalNumberTextInput],
	completionNote: signalCompletionNote,
	dmPolicy: signalDmPolicy,
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
export { signalSetupWizard };
