import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { n as listChatCommands, r as listChatCommandsForConfig } from "./commands-registry-list--98FRviq.js";
import { r as normalizeCommandBody } from "./commands-registry-normalize-CnHNsvCE.js";
import { r as isAbortTrigger } from "./abort-primitives-BPrDmF9O.js";
//#region src/auto-reply/command-detection.ts
function hasControlCommand(text, cfg, options) {
	if (!text) return false;
	const trimmed = text.trim();
	if (!trimmed) return false;
	const stripped = stripInboundMetadata(trimmed);
	if (!stripped) return false;
	const normalizedBody = normalizeCommandBody(stripped, options);
	if (!normalizedBody) return false;
	const lowered = normalizeLowercaseStringOrEmpty(normalizedBody);
	const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
	for (const command of commands) for (const alias of command.textAliases) {
		const normalized = normalizeOptionalLowercaseString(alias);
		if (!normalized) continue;
		if (lowered === normalized) return true;
		if (command.acceptsArgs && lowered.startsWith(normalized)) {
			const nextChar = normalizedBody.charAt(normalized.length);
			if (nextChar && /\s/.test(nextChar)) return true;
		}
	}
	return false;
}
function isControlCommandMessage(text, cfg, options) {
	if (!text) return false;
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (hasControlCommand(trimmed, cfg, options)) return true;
	return isAbortTrigger(normalizeOptionalLowercaseString(normalizeCommandBody(stripInboundMetadata(trimmed), options)) ?? "");
}
/**
* Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
* can decide whether to compute CommandAuthorized for a message.
*
* This intentionally errs on the side of false positives; CommandAuthorized only gates
* command/directive execution, not normal chat replies.
*/
function hasInlineCommandTokens(text) {
	const body = text ?? "";
	if (!body.trim()) return false;
	return /(?:^|\s)[/!][a-z]/i.test(body);
}
function shouldComputeCommandAuthorized(text, cfg, options) {
	return isControlCommandMessage(text, cfg, options) || hasInlineCommandTokens(text);
}
//#endregion
export { shouldComputeCommandAuthorized as i, hasInlineCommandTokens as n, isControlCommandMessage as r, hasControlCommand as t };
