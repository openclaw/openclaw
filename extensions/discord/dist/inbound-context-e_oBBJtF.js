import { h as resolveDiscordOwnerAllowFrom, p as resolveDiscordMemberAllowed } from "./allow-list-ek-1hMKN.js";
import { buildUntrustedChannelMetadata, wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
//#region extensions/discord/src/monitor/inbound-context.ts
function createDiscordSupplementalContextAccessChecker(params) {
	return (sender) => {
		if (!params.isGuild) return true;
		return resolveDiscordMemberAllowed({
			userAllowList: params.channelConfig?.users ?? params.guildInfo?.users,
			roleAllowList: params.channelConfig?.roles ?? params.guildInfo?.roles,
			memberRoleIds: sender.memberRoleIds ?? [],
			userId: sender.id ?? "",
			userName: sender.name,
			userTag: sender.tag,
			allowNameMatching: params.allowNameMatching
		});
	};
}
function buildDiscordGroupSystemPrompt(channelConfig) {
	const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter((entry) => Boolean(entry));
	return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0;
}
function buildDiscordUntrustedContext(params) {
	if (!params.isGuild) return;
	const entries = [buildUntrustedChannelMetadata({
		source: "discord",
		label: "Discord channel topic",
		entries: [params.channelTopic]
	}), typeof params.messageBody === "string" && params.messageBody.trim().length > 0 ? wrapExternalContent(`UNTRUSTED Discord message body\n${params.messageBody.trim()}`, {
		source: "unknown",
		includeWarning: false
	}) : void 0].filter((entry) => Boolean(entry));
	return entries.length > 0 ? entries : void 0;
}
function buildDiscordInboundAccessContext(params) {
	return {
		groupSystemPrompt: params.isGuild ? buildDiscordGroupSystemPrompt(params.channelConfig) : void 0,
		untrustedContext: buildDiscordUntrustedContext({
			isGuild: params.isGuild,
			channelTopic: params.channelTopic,
			messageBody: params.messageBody
		}),
		ownerAllowFrom: resolveDiscordOwnerAllowFrom({
			channelConfig: params.channelConfig,
			guildInfo: params.guildInfo,
			sender: params.sender,
			allowNameMatching: params.allowNameMatching
		})
	};
}
//#endregion
export { buildDiscordInboundAccessContext as n, createDiscordSupplementalContextAccessChecker as r, buildDiscordGroupSystemPrompt as t };
