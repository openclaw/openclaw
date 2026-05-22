import { l as normalizeE164 } from "./utils-CRkrr5e6.js";
import { r as jidToE164 } from "./text-runtime-CsFIOwAc.js";
//#region extensions/whatsapp/src/identity.ts
const WHATSAPP_LID_RE = /@(lid|hosted\.lid)$/i;
function normalizeDeviceScopedJid(jid) {
	return jid ? jid.replace(/:\d+/, "") : null;
}
function isLidJid(jid) {
	return Boolean(jid && WHATSAPP_LID_RE.test(jid));
}
function resolveComparableIdentity(identity, authDir) {
	const rawJid = normalizeDeviceScopedJid(identity?.jid);
	const lid = normalizeDeviceScopedJid(identity?.lid) ?? (isLidJid(rawJid) ? rawJid : null);
	const jid = rawJid && !isLidJid(rawJid) ? rawJid : null;
	const e164 = identity?.e164 != null ? normalizeE164(identity.e164) : (jid ? jidToE164(jid, authDir ? { authDir } : void 0) : null) ?? (lid ? jidToE164(lid, authDir ? { authDir } : void 0) : null);
	return {
		...identity,
		jid,
		lid,
		e164
	};
}
function getComparableIdentityValues(identity) {
	const resolved = resolveComparableIdentity(identity);
	return [
		resolved.e164,
		resolved.jid,
		resolved.lid
	].filter((value) => Boolean(value));
}
function identitiesOverlap(left, right) {
	const leftValues = new Set(getComparableIdentityValues(left));
	if (leftValues.size === 0) return false;
	return getComparableIdentityValues(right).some((value) => leftValues.has(value));
}
function getSenderIdentity(msg, authDir) {
	return resolveComparableIdentity(msg.sender ?? {
		jid: msg.senderJid ?? null,
		e164: msg.senderE164 ?? null,
		name: msg.senderName ?? null
	}, authDir);
}
function getSelfIdentity(msg, authDir) {
	return resolveComparableIdentity(msg.self ?? {
		jid: msg.selfJid ?? null,
		lid: msg.selfLid ?? null,
		e164: msg.selfE164 ?? null
	}, authDir);
}
function getReplyContext(msg, authDir) {
	if (msg.replyTo) return {
		...msg.replyTo,
		sender: resolveComparableIdentity(msg.replyTo.sender, authDir)
	};
	if (!msg.replyToBody) return null;
	return {
		id: msg.replyToId,
		body: msg.replyToBody,
		sender: resolveComparableIdentity({
			jid: msg.replyToSenderJid ?? null,
			e164: msg.replyToSenderE164 ?? null,
			label: msg.replyToSender ?? null
		}, authDir)
	};
}
function getMentionJids(msg) {
	return msg.mentions ?? msg.mentionedJids ?? [];
}
function getMentionIdentities(msg, authDir) {
	return getMentionJids(msg).map((jid) => resolveComparableIdentity({ jid }, authDir));
}
function getPrimaryIdentityId(identity) {
	return identity?.e164 || identity?.jid?.trim() || identity?.lid || null;
}
//#endregion
export { getSelfIdentity as a, resolveComparableIdentity as c, getReplyContext as i, getMentionIdentities as n, getSenderIdentity as o, getPrimaryIdentityId as r, identitiesOverlap as s, getComparableIdentityValues as t };
