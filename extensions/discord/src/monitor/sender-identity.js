import { formatDiscordUserTag } from "./format.js";
function resolveDiscordWebhookId(message) {
  const candidate = message.webhookId ?? message.webhook_id;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
function resolveDiscordSenderIdentity(params) {
  const pkInfo = params.pluralkitInfo ?? null;
  const pkMember = pkInfo?.member ?? void 0;
  const pkSystem = pkInfo?.system ?? void 0;
  const memberId = pkMember?.id?.trim();
  const memberNameRaw = pkMember?.display_name ?? pkMember?.name ?? "";
  const memberName = memberNameRaw?.trim();
  if (memberId && memberName) {
    const systemName = pkSystem?.name?.trim();
    const label = systemName ? `${memberName} (PK:${systemName})` : `${memberName} (PK)`;
    return {
      id: memberId,
      name: memberName,
      tag: pkMember?.name?.trim() || void 0,
      label,
      isPluralKit: true,
      pluralkit: {
        memberId,
        memberName,
        systemId: pkSystem?.id?.trim() || void 0,
        systemName
      }
    };
  }
  const senderTag = formatDiscordUserTag(params.author);
  const senderDisplay = params.member?.nickname ?? params.author.globalName ?? params.author.username;
  const senderLabel = senderDisplay && senderTag && senderDisplay !== senderTag ? `${senderDisplay} (${senderTag})` : senderDisplay ?? senderTag ?? params.author.id;
  return {
    id: params.author.id,
    name: params.author.username ?? void 0,
    tag: senderTag,
    label: senderLabel,
    isPluralKit: false
  };
}
function resolveDiscordSenderLabel(params) {
  return resolveDiscordSenderIdentity(params).label;
}
export {
  resolveDiscordSenderIdentity,
  resolveDiscordSenderLabel,
  resolveDiscordWebhookId
};
