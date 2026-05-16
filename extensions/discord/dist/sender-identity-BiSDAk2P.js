import { n as formatDiscordUserTag } from "./format-D8TsaXxW.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
//#region extensions/discord/src/monitor/sender-identity.ts
function resolveDiscordWebhookId(message) {
	const candidate = message.webhookId ?? message.webhook_id;
	return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
function resolveDiscordSenderIdentity(params) {
	const pkInfo = params.pluralkitInfo ?? null;
	const pkMember = pkInfo?.member ?? void 0;
	const pkSystem = pkInfo?.system ?? void 0;
	const memberId = pkMember?.id?.trim();
	const memberName = (pkMember?.display_name ?? pkMember?.name ?? "")?.trim();
	if (memberId && memberName) {
		const systemName = pkSystem?.name?.trim();
		const label = systemName ? `${memberName} (PK:${systemName})` : `${memberName} (PK)`;
		return {
			id: memberId,
			name: memberName,
			tag: normalizeOptionalString(pkMember?.name),
			label,
			isPluralKit: true,
			pluralkit: {
				memberId,
				memberName,
				systemId: normalizeOptionalString(pkSystem?.id),
				systemName
			}
		};
	}
	const senderTag = formatDiscordUserTag(params.author);
	const senderDisplay = params.member?.nickname ?? params.member?.nick ?? params.author.globalName ?? params.author.username;
	const senderLabel = senderDisplay && senderTag && senderDisplay !== senderTag ? `${senderDisplay} (${senderTag})` : senderDisplay ?? senderTag ?? params.author.id;
	return {
		id: params.author.id,
		name: params.author.username ?? void 0,
		tag: senderTag,
		label: senderLabel,
		isPluralKit: false
	};
}
//#endregion
export { resolveDiscordWebhookId as n, resolveDiscordSenderIdentity as t };
