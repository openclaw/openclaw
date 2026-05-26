import { t as detectBinary } from "./detect-binary-C4HxcF68.js";
import "./setup-binary-BeEfo44C.js";
//#region src/channels/plugins/setup-wizard-binary.ts
function createDetectedBinaryStatus(params) {
	const detectBinary$1 = params.detectBinary ?? detectBinary;
	return {
		configuredLabel: params.configuredLabel,
		unconfiguredLabel: params.unconfiguredLabel,
		configuredHint: params.configuredHint,
		unconfiguredHint: params.unconfiguredHint,
		configuredScore: params.configuredScore,
		unconfiguredScore: params.unconfiguredScore,
		resolveConfigured: params.resolveConfigured,
		async resolveStatusLines({ cfg, accountId, configured }) {
			const binaryPath = params.resolveBinaryPath({
				cfg,
				accountId
			});
			const detected = await detectBinary$1(binaryPath);
			return [`${params.channelLabel}: ${configured ? params.configuredLabel : params.unconfiguredLabel}`, `${params.binaryLabel}: ${detected ? "found" : "missing"} (${binaryPath})`];
		},
		async resolveSelectionHint({ cfg, accountId }) {
			return await detectBinary$1(params.resolveBinaryPath({
				cfg,
				accountId
			})) ? params.configuredHint : params.unconfiguredHint;
		},
		async resolveQuickstartScore({ cfg, accountId }) {
			return await detectBinary$1(params.resolveBinaryPath({
				cfg,
				accountId
			})) ? params.configuredScore : params.unconfiguredScore;
		}
	};
}
function createCliPathTextInput(params) {
	return {
		inputKey: params.inputKey,
		message: params.message,
		currentValue: params.resolvePath,
		initialValue: params.resolvePath,
		shouldPrompt: params.shouldPrompt,
		confirmCurrentValue: false,
		applyCurrentValue: true,
		...params.helpTitle ? { helpTitle: params.helpTitle } : {},
		...params.helpLines ? { helpLines: params.helpLines } : {}
	};
}
function createDelegatedSetupWizardStatusResolvers(loadWizard) {
	return {
		async resolveStatusLines(params) {
			return (await loadWizard()).status.resolveStatusLines?.(params) ?? [];
		},
		async resolveSelectionHint(params) {
			return await (await loadWizard()).status.resolveSelectionHint?.(params);
		},
		async resolveQuickstartScore(params) {
			return await (await loadWizard()).status.resolveQuickstartScore?.(params);
		}
	};
}
function createDelegatedTextInputShouldPrompt(params) {
	return async (inputParams) => {
		return await ((await params.loadWizard()).textInputs?.find((entry) => entry.inputKey === params.inputKey))?.shouldPrompt?.(inputParams) ?? false;
	};
}
//#endregion
//#region src/channels/plugins/setup-wizard-proxy.ts
function createDelegatedResolveConfigured(loadWizard) {
	return async ({ cfg, accountId }) => await (await loadWizard()).status.resolveConfigured({
		cfg,
		accountId
	});
}
function createDelegatedPrepare(loadWizard) {
	return async (params) => await (await loadWizard()).prepare?.(params);
}
function createDelegatedFinalize(loadWizard) {
	return async (params) => await (await loadWizard()).finalize?.(params);
}
function createDelegatedSetupWizardProxy(params) {
	return {
		channel: params.channel,
		status: {
			...params.status,
			resolveConfigured: createDelegatedResolveConfigured(params.loadWizard),
			...createDelegatedSetupWizardStatusResolvers(params.loadWizard)
		},
		...params.resolveShouldPromptAccountIds ? { resolveShouldPromptAccountIds: params.resolveShouldPromptAccountIds } : {},
		...params.delegatePrepare ? { prepare: createDelegatedPrepare(params.loadWizard) } : {},
		credentials: params.credentials ?? [],
		...params.textInputs ? { textInputs: params.textInputs } : {},
		...params.delegateFinalize ? { finalize: createDelegatedFinalize(params.loadWizard) } : {},
		...params.completionNote ? { completionNote: params.completionNote } : {},
		...params.dmPolicy ? { dmPolicy: params.dmPolicy } : {},
		...params.disable ? { disable: params.disable } : {},
		...params.onAccountRecorded ? { onAccountRecorded: params.onAccountRecorded } : {}
	};
}
function createAllowlistSetupWizardProxy(params) {
	return params.createBase({
		promptAllowFrom: async ({ cfg, prompter, accountId }) => {
			const wizard = await params.loadWizard();
			if (!wizard.dmPolicy?.promptAllowFrom) return cfg;
			return await wizard.dmPolicy.promptAllowFrom({
				cfg,
				prompter,
				accountId
			});
		},
		resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) => {
			const wizard = await params.loadWizard();
			if (!wizard.allowFrom) return entries.map((input) => ({
				input,
				resolved: false,
				id: null
			}));
			return await wizard.allowFrom.resolveEntries({
				cfg,
				accountId,
				credentialValues,
				entries
			});
		},
		resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
			const wizard = await params.loadWizard();
			if (!wizard.groupAccess?.resolveAllowlist) return params.fallbackResolvedGroupAllowlist(entries);
			return await wizard.groupAccess.resolveAllowlist({
				cfg,
				accountId,
				credentialValues,
				entries,
				prompter
			});
		}
	});
}
//#endregion
export { createDelegatedSetupWizardProxy as a, createDelegatedTextInputShouldPrompt as c, createDelegatedResolveConfigured as i, createDetectedBinaryStatus as l, createDelegatedFinalize as n, createCliPathTextInput as o, createDelegatedPrepare as r, createDelegatedSetupWizardStatusResolvers as s, createAllowlistSetupWizardProxy as t };
