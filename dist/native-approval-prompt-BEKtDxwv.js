import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as resolveChannelApprovalCapability } from "./plugins-DYTHbmt7.js";
//#region src/channels/plugins/native-approval-prompt.ts
const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY = "nativeApprovals";
const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED = "nativeapprovals";
const KNOWN_NATIVE_APPROVAL_PROMPT_CHANNELS = new Set([
	"discord",
	"matrix",
	"qqbot",
	"slack",
	"telegram"
]);
function channelPluginHasNativeApprovalPromptUi(plugin) {
	const capability = resolveChannelApprovalCapability(plugin);
	return Boolean(capability?.native || capability?.nativeRuntime);
}
function isKnownNativeApprovalPromptChannel(channel) {
	const normalized = normalizeOptionalLowercaseString(channel);
	return Boolean(normalized && KNOWN_NATIVE_APPROVAL_PROMPT_CHANNELS.has(normalized));
}
function hasNativeApprovalPromptRuntimeCapability(capabilities) {
	return Boolean(capabilities?.some((capability) => normalizeOptionalLowercaseString(capability) === NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED));
}
//#endregion
export { isKnownNativeApprovalPromptChannel as i, channelPluginHasNativeApprovalPromptUi as n, hasNativeApprovalPromptRuntimeCapability as r, NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY as t };
