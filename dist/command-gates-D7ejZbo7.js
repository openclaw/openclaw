import { r as logVerbose } from "./globals-CouSpJO4.js";
import { t as isCommandFlagEnabled } from "./commands.flags-CAoq2uXC.js";
import { r as isInternalMessageChannel } from "./message-channel-s-A-ruKR.js";
import { t as redactIdentifier } from "./redact-identifier-B2TARbc1.js";
//#region src/auto-reply/reply/command-gates.ts
function buildNativeCommandGateReply(text) {
	return {
		shouldContinue: false,
		reply: { text }
	};
}
function rejectUnauthorizedCommand(params, commandLabel) {
	if (params.command.isAuthorizedSender) return null;
	logVerbose(`Ignoring ${commandLabel} from unauthorized sender: ${redactIdentifier(params.command.senderId)}`);
	if (params.ctx.CommandSource === "native") return buildNativeCommandGateReply("You are not authorized to use this command.");
	return { shouldContinue: false };
}
function rejectNonOwnerCommand(params, commandLabel) {
	if (params.command.senderIsOwner) return null;
	logVerbose(`Ignoring ${commandLabel} from non-owner sender: ${redactIdentifier(params.command.senderId)}`);
	if (params.ctx.CommandSource === "native") return buildNativeCommandGateReply("You are not authorized to use this command.");
	return { shouldContinue: false };
}
function requireGatewayClientScopeForInternalChannel(params, config) {
	if (!isInternalMessageChannel(params.command.channel)) return null;
	const scopes = params.ctx.GatewayClientScopes ?? [];
	if (config.allowedScopes.some((scope) => scopes.includes(scope))) return null;
	logVerbose(`Ignoring ${config.label} from gateway client missing scope: ${config.allowedScopes.join(" or ")}`);
	return {
		shouldContinue: false,
		reply: { text: config.missingText }
	};
}
function buildDisabledCommandReply(params) {
	const disabledVerb = params.disabledVerb ?? "is";
	const docsSuffix = params.docsUrl ? ` Docs: ${params.docsUrl}` : "";
	return { text: `⚠️ ${params.label} ${disabledVerb} disabled. Set commands.${params.configKey}=true to enable.${docsSuffix}` };
}
function requireCommandFlagEnabled(cfg, params) {
	if (isCommandFlagEnabled(cfg, params.configKey)) return null;
	return {
		shouldContinue: false,
		reply: buildDisabledCommandReply(params)
	};
}
//#endregion
export { requireGatewayClientScopeForInternalChannel as a, requireCommandFlagEnabled as i, rejectNonOwnerCommand as n, rejectUnauthorizedCommand as r, buildDisabledCommandReply as t };
