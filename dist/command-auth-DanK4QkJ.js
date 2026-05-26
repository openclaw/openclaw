import "./commands-registry-CPSWhUW1.js";
import "./command-auth-BZf85E5V.js";
import "./command-specs-B7OJWPwd.js";
import "./command-detection-bZlW0Mh2.js";
import { o as resolveDmGroupAccessWithLists } from "./channel-access-compat-Dny0RAlV.js";
import "./stored-model-override-IjcwakfK.js";
import { t as expandAllowFromWithAccessGroups } from "./access-groups-BCwpa3XZ.js";
import { n as buildCommandsMessagePaginated$1, r as buildHelpMessage$1, t as buildCommandsMessage$1 } from "./command-status-builders-Br_oliJw.js";
import "./direct-dm-DhLrASUF.js";
import "./skill-commands-D7lNGMWZ.js";
import "./commands-models-DXsv2Mp0.js";
//#region src/plugin-sdk/telegram-command-ui.ts
function buildCommandsPaginationKeyboard(currentPage, totalPages, agentId) {
	const buttons = [];
	const suffix = agentId ? `:${agentId}` : "";
	if (currentPage > 1) buttons.push({
		text: "◀ Prev",
		callback_data: `commands_page_${currentPage - 1}${suffix}`
	});
	buttons.push({
		text: `${currentPage}/${totalPages}`,
		callback_data: `commands_page_noop${suffix}`
	});
	if (currentPage < totalPages) buttons.push({
		text: "Next ▶",
		callback_data: `commands_page_${currentPage + 1}${suffix}`
	});
	return [buttons];
}
//#endregion
//#region src/plugin-sdk/command-auth.ts
/**
* @deprecated Public SDK subpath has no bundled extension production imports.
* Use channel ingress/runtime authorization helpers or command-status helpers
* instead of this broad compatibility surface.
*/
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function resolveDirectDmAuthorizationOutcome(params) {
	if (params.isGroup) return "allowed";
	if (params.dmPolicy === "disabled") return "disabled";
	if (!params.senderAllowedForCommands) return "unauthorized";
	return "allowed";
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
async function resolveSenderCommandAuthorizationWithRuntime(params) {
	return resolveSenderCommandAuthorization({
		...params,
		shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
		resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers
	});
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
async function resolveSenderCommandAuthorization(params) {
	const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	const storeAllowFrom = !params.isGroup && params.dmPolicy !== "allowlist" && params.dmPolicy !== "open" ? await params.readAllowFromStore().catch(() => []) : [];
	const channel = params.channel;
	const accountId = params.accountId ?? "default";
	let configuredAllowFrom = params.configuredAllowFrom;
	let configuredGroupAllowFrom = params.configuredGroupAllowFrom ?? [];
	let dmStoreAllowFrom = storeAllowFrom;
	if (channel) {
		[configuredAllowFrom, configuredGroupAllowFrom] = await Promise.all([expandAllowFromWithAccessGroups({
			cfg: params.cfg,
			allowFrom: params.configuredAllowFrom,
			channel,
			accountId,
			senderId: params.senderId,
			isSenderAllowed: params.isSenderAllowed,
			resolveMembership: params.resolveAccessGroupMembership
		}), expandAllowFromWithAccessGroups({
			cfg: params.cfg,
			allowFrom: params.configuredGroupAllowFrom ?? [],
			channel,
			accountId,
			senderId: params.senderId,
			isSenderAllowed: params.isSenderAllowed,
			resolveMembership: params.resolveAccessGroupMembership
		})]);
		if (!params.isGroup) dmStoreAllowFrom = await expandAllowFromWithAccessGroups({
			cfg: params.cfg,
			allowFrom: storeAllowFrom,
			channel,
			accountId,
			senderId: params.senderId,
			isSenderAllowed: params.isSenderAllowed,
			resolveMembership: params.resolveAccessGroupMembership
		});
	}
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: "allowlist",
		allowFrom: configuredAllowFrom,
		groupAllowFrom: configuredGroupAllowFrom,
		storeAllowFrom: dmStoreAllowFrom,
		isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom)
	});
	const effectiveAllowFrom = access.effectiveAllowFrom;
	const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const senderAllowedForCommands = params.isSenderAllowed(params.senderId, params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom);
	const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
	return {
		shouldComputeAuth,
		effectiveAllowFrom,
		effectiveGroupAllowFrom,
		senderAllowedForCommands,
		commandAuthorized: shouldComputeAuth ? params.resolveCommandAuthorizedFromAuthorizers?.({
			useAccessGroups,
			authorizers: [{
				configured: effectiveAllowFrom.length > 0,
				allowed: ownerAllowedForCommands
			}, {
				configured: effectiveGroupAllowFrom.length > 0,
				allowed: groupAllowedForCommands
			}]
		}) ?? senderAllowedForCommands : void 0
	};
}
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
function buildCommandsMessage(...args) {
	return buildCommandsMessage$1(...args);
}
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
function buildCommandsMessagePaginated(...args) {
	return buildCommandsMessagePaginated$1(...args);
}
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
function buildHelpMessage(...args) {
	return buildHelpMessage$1(...args);
}
//#endregion
export { resolveSenderCommandAuthorization as a, resolveDirectDmAuthorizationOutcome as i, buildCommandsMessagePaginated as n, resolveSenderCommandAuthorizationWithRuntime as o, buildHelpMessage as r, buildCommandsPaginationKeyboard as s, buildCommandsMessage as t };
