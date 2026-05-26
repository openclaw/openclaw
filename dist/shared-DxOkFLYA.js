import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { o as getChannelsCommandSecretTargetIds } from "./command-secret-targets-UUlaHEu2.js";
import { t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-YzCGlwrq.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-QySEqFLr.js";
import { n as requireValidConfigSnapshot } from "./config-validation-CSay_Jnk.js";
//#region src/commands/channels/shared.ts
async function requireValidConfig(runtime = defaultRuntime, secretResolution) {
	const cfg = await requireValidConfigSnapshot(runtime);
	if (!cfg) return null;
	const { effectiveConfig } = await resolveCommandConfigWithSecrets({
		config: cfg,
		commandName: secretResolution?.commandName ?? "channels",
		targetIds: getChannelsCommandSecretTargetIds(),
		mode: secretResolution?.mode,
		runtime
	});
	return effectiveConfig;
}
function formatAccountLabel(params) {
	const base = params.accountId || "default";
	if (params.name?.trim()) return `${base} (${params.name.trim()})`;
	return base;
}
function formatChannelAccountLabel(params) {
	const channelText = params.channelLabel ?? params.channel;
	const accountText = formatAccountLabel({
		accountId: params.accountId,
		name: params.name
	});
	return `${params.channelStyle ? params.channelStyle(channelText) : channelText} ${params.accountStyle ? params.accountStyle(accountText) : accountText}`;
}
function appendEnabledConfiguredLinkedBits(bits, account) {
	if (typeof account.enabled === "boolean") bits.push(account.enabled ? "enabled" : "disabled");
	if (typeof account.configured === "boolean") if (account.configured) {
		bits.push("configured");
		if (hasConfiguredUnavailableCredentialStatus(account)) bits.push("secret unavailable in this command path");
	} else bits.push("not configured");
	if (typeof account.linked === "boolean") bits.push(account.linked ? "linked" : "not linked");
}
function appendModeBit(bits, account) {
	if (typeof account.mode === "string" && account.mode.length > 0) bits.push(`mode:${account.mode}`);
}
function appendTokenSourceBits(bits, account) {
	const appendSourceBit = (label, sourceKey, statusKey) => {
		const source = account[sourceKey];
		if (typeof source !== "string" || !source || source === "none") return;
		const unavailable = account[statusKey] === "configured_unavailable" ? " (unavailable)" : "";
		bits.push(`${label}:${source}${unavailable}`);
	};
	appendSourceBit("token", "tokenSource", "tokenStatus");
	appendSourceBit("bot", "botTokenSource", "botTokenStatus");
	appendSourceBit("app", "appTokenSource", "appTokenStatus");
	appendSourceBit("signing", "signingSecretSource", "signingSecretStatus");
}
function appendBaseUrlBit(bits, account) {
	if (typeof account.baseUrl === "string" && account.baseUrl) bits.push(`url:${account.baseUrl}`);
}
function buildChannelAccountLine(provider, account, bits, opts) {
	return `- ${formatChannelAccountLabel({
		channel: provider,
		accountId: typeof account.accountId === "string" ? account.accountId : DEFAULT_ACCOUNT_ID,
		name: typeof account.name === "string" ? account.name : void 0,
		channelLabel: opts?.channelLabel
	})}: ${bits.join(", ")}`;
}
function shouldUseWizard(params) {
	return params?.hasFlags === false;
}
//#endregion
export { buildChannelAccountLine as a, shouldUseWizard as c, appendTokenSourceBits as i, appendEnabledConfiguredLinkedBits as n, formatChannelAccountLabel as o, appendModeBit as r, requireValidConfig as s, appendBaseUrlBit as t };
