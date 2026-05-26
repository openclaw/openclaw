import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { l as normalizeE164 } from "./utils-sBTEdeml.js";
import "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as createSetupInputPresenceValidator, i as createPatchedAccountSetupAdapter } from "./setup-helpers-BC9z9VvG.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { C as parseSetupEntriesAllowingWildcard, J as setSetupChannelEnabled, T as patchChannelConfigForAccount, V as setAccountAllowFromForChannel, j as promptParsedAllowFromForAccount, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import { a as createDelegatedSetupWizardProxy, c as createDelegatedTextInputShouldPrompt, o as createCliPathTextInput } from "./setup-wizard-proxy-B15glc8O.js";
import "./setup-runtime-BRbeJqWD.js";
import "./setup-tools-DuiMNzp5.js";
import "./text-utility-runtime-CaGXarh9.js";
import { i as resolveSignalAccount, r as resolveDefaultSignalAccountId } from "./accounts-D8MTjG-n.js";
//#region extensions/signal/src/setup-core.ts
const t = createSetupTranslator();
const channel = "signal";
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR = "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";
function normalizeSignalAccountInput(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return null;
	const digits = normalizeE164(trimmed).slice(1);
	if (!DIGITS_ONLY.test(digits)) return null;
	if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
	return `+${digits}`;
}
function isUuidLike(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function parseSignalAllowFromEntries(raw) {
	return parseSetupEntriesAllowingWildcard(raw, (entry) => {
		if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
			const id = entry.slice(5).trim();
			if (!id) return { error: "Invalid uuid entry" };
			return { value: `uuid:${id}` };
		}
		if (isUuidLike(entry)) return { value: `uuid:${entry}` };
		const normalized = normalizeSignalAccountInput(entry);
		if (!normalized) return { error: `Invalid entry: ${entry}` };
		return { value: normalized };
	});
}
function buildSignalSetupPatch(input) {
	return {
		...input.signalNumber ? { account: input.signalNumber } : {},
		...input.cliPath ? { cliPath: input.cliPath } : {},
		...input.httpUrl ? { httpUrl: input.httpUrl } : {},
		...input.httpHost ? { httpHost: input.httpHost } : {},
		...input.httpPort ? { httpPort: Number(input.httpPort) } : {}
	};
}
async function promptSignalAllowFrom(params) {
	return promptParsedAllowFromForAccount({
		cfg: params.cfg,
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: t("wizard.signal.allowlistTitle"),
		noteLines: [
			t("wizard.signal.allowlistIntro"),
			t("wizard.signal.examples"),
			"- +15555550123",
			"- uuid:123e4567-e89b-12d3-a456-426614174000",
			t("wizard.signal.multipleEntries"),
			`Docs: ${formatDocsLink("/signal", "signal")}`
		],
		message: t("wizard.signal.allowFromPrompt"),
		placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
		parseEntries: parseSignalAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => resolveSignalAccount({
			cfg,
			accountId
		}).config.allowFrom ?? [],
		applyAllowFrom: ({ cfg, accountId, allowFrom }) => setAccountAllowFromForChannel({
			cfg,
			channel,
			accountId,
			allowFrom
		})
	});
}
const signalDmPolicy = {
	label: "Signal",
	channel,
	policyKey: "channels.signal.dmPolicy",
	allowFromKey: "channels.signal.allowFrom",
	resolveConfigKeys: (cfg, accountId) => (accountId ?? resolveDefaultSignalAccountId(cfg)) !== "default" ? {
		policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
		allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`
	} : {
		policyKey: "channels.signal.dmPolicy",
		allowFromKey: "channels.signal.allowFrom"
	},
	getCurrent: (cfg, accountId) => resolveSignalAccount({
		cfg,
		accountId: accountId ?? resolveDefaultSignalAccountId(cfg)
	}).config.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => patchChannelConfigForAccount({
		cfg,
		channel,
		accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
		patch: policy === "open" ? {
			dmPolicy: "open",
			allowFrom: mergeAllowFromEntries(resolveSignalAccount({
				cfg,
				accountId: accountId ?? resolveDefaultSignalAccountId(cfg)
			}).config.allowFrom, ["*"])
		} : { dmPolicy: policy }
	}),
	promptAllowFrom: promptSignalAllowFrom
};
function resolveSignalCliPath(params) {
	return (typeof params.credentialValues.cliPath === "string" ? params.credentialValues.cliPath : void 0) ?? resolveSignalAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.cliPath ?? "signal-cli";
}
function createSignalCliPathTextInput(shouldPrompt) {
	return createCliPathTextInput({
		inputKey: "cliPath",
		message: "signal-cli path",
		resolvePath: ({ cfg, accountId, credentialValues }) => resolveSignalCliPath({
			cfg,
			accountId,
			credentialValues
		}),
		shouldPrompt,
		helpTitle: "Signal",
		helpLines: ["signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath."]
	});
}
const signalNumberTextInput = {
	inputKey: "signalNumber",
	message: t("wizard.signal.botNumberPrompt"),
	currentValue: ({ cfg, accountId }) => normalizeSignalAccountInput(resolveSignalAccount({
		cfg,
		accountId
	}).config.account) ?? void 0,
	keepPrompt: (value) => t("wizard.signal.accountKeep", { value }),
	validate: ({ value }) => normalizeSignalAccountInput(value) ? void 0 : INVALID_SIGNAL_ACCOUNT_ERROR,
	normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value
};
const signalCompletionNote = {
	title: t("wizard.signal.nextStepsTitle"),
	lines: [
		t("wizard.signal.nextLinkDevice"),
		t("wizard.signal.nextScanQr"),
		`Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
		`Docs: ${formatDocsLink("/signal", "signal")}`
	]
};
const signalSetupAdapter = createPatchedAccountSetupAdapter({
	channelKey: channel,
	validateInput: createSetupInputPresenceValidator({ validate: ({ input }) => {
		if (!input.signalNumber && !input.httpUrl && !input.httpHost && !input.httpPort && !input.cliPath) return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
		return null;
	} }),
	buildPatch: (input) => buildSignalSetupPatch(input)
});
function createSignalSetupWizardProxy(loadWizard) {
	return createDelegatedSetupWizardProxy({
		channel,
		loadWizard,
		status: {
			configuredLabel: t("wizard.channels.statusConfigured"),
			unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
			configuredHint: t("wizard.channels.statusSignalCliFound"),
			unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
			configuredScore: 1,
			unconfiguredScore: 0
		},
		delegatePrepare: true,
		credentials: [],
		textInputs: [createSignalCliPathTextInput(createDelegatedTextInputShouldPrompt({
			loadWizard,
			inputKey: "cliPath"
		})), signalNumberTextInput],
		completionNote: signalCompletionNote,
		dmPolicy: signalDmPolicy,
		disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
	});
}
//#endregion
export { signalDmPolicy as a, signalCompletionNote as i, createSignalSetupWizardProxy as n, signalNumberTextInput as o, normalizeSignalAccountInput as r, signalSetupAdapter as s, createSignalCliPathTextInput as t };
