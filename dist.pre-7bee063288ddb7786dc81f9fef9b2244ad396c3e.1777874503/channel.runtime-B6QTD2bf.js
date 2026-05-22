import { J as setSetupChannelEnabled } from "./setup-wizard-helpers-D8cUTbTq.js";
import { t as detectBinary } from "./detect-binary-UN2KbLBa.js";
import { l as createDetectedBinaryStatus } from "./setup-wizard-proxy-CDIFcJHW.js";
import "./setup-C421YIRA.js";
import "./setup-tools-DdUgobpV.js";
import { i as resolveSignalAccount, n as listSignalAccountIds } from "./accounts-BOLNSiam.js";
import { a as signalDmPolicy, i as signalCompletionNote, o as signalNumberTextInput, t as createSignalCliPathTextInput } from "./setup-core-CKqLzBya.js";
import { r as installSignalCli } from "./install-signal-cli-BP7Ux4gq.js";
//#region extensions/signal/src/setup-surface.ts
const channel = "signal";
//#endregion
//#region extensions/signal/src/channel.runtime.ts
const signalSetupWizard = {
	channel,
	status: createDetectedBinaryStatus({
		channelLabel: "Signal",
		binaryLabel: "signal-cli",
		configuredLabel: "configured",
		unconfiguredLabel: "needs setup",
		configuredHint: "signal-cli found",
		unconfiguredHint: "signal-cli missing",
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
			message: cliDetected ? "signal-cli detected. Reinstall/update now?" : "signal-cli not found. Install now?",
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
