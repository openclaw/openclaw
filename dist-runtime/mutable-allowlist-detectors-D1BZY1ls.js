//#region src/security/mutable-allowlist-detectors.ts
function isDiscordMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const maybeMentionId = text.replace(/^<@!?/, "").replace(/>$/, "");
	if (/^\d+$/.test(maybeMentionId)) return false;
	for (const prefix of [
		"discord:",
		"user:",
		"pk:"
	]) {
		if (!text.startsWith(prefix)) continue;
		return text.slice(prefix.length).trim().length === 0;
	}
	return true;
}
function isSlackMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const mentionMatch = text.match(/^<@([A-Z0-9]+)>$/i);
	if (mentionMatch && /^[A-Z0-9]{8,}$/i.test(mentionMatch[1] ?? "")) return false;
	const withoutPrefix = text.replace(/^(slack|user):/i, "").trim();
	if (/^[UWBCGDT][A-Z0-9]{2,}$/.test(withoutPrefix)) return false;
	if (/^[A-Z0-9]{8,}$/i.test(withoutPrefix)) return false;
	return true;
}
function isGoogleChatMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const withoutPrefix = text.replace(/^(googlechat|google-chat|gchat):/i, "").trim();
	if (!withoutPrefix) return false;
	return withoutPrefix.replace(/^users\//i, "").includes("@");
}
function isMSTeamsMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const withoutPrefix = text.replace(/^(msteams|user):/i, "").trim();
	return /\s/.test(withoutPrefix) || withoutPrefix.includes("@");
}
function isMattermostMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const normalized = text.replace(/^(mattermost|user):/i, "").replace(/^@/, "").trim().toLowerCase();
	if (/^[a-z0-9]{26}$/.test(normalized)) return false;
	return true;
}
function isIrcMutableAllowEntry(raw) {
	const text = raw.trim().toLowerCase();
	if (!text || text === "*") return false;
	const normalized = text.replace(/^irc:/, "").replace(/^user:/, "").trim();
	return !normalized.includes("!") && !normalized.includes("@");
}
function isZalouserMutableGroupEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const normalized = text.replace(/^(zalouser|zlu):/i, "").replace(/^group:/i, "").trim();
	if (!normalized) return false;
	if (/^\d+$/.test(normalized)) return false;
	return !/^g-\S+$/i.test(normalized);
}
//#endregion
export { isMattermostMutableAllowEntry as a, isMSTeamsMutableAllowEntry as i, isGoogleChatMutableAllowEntry as n, isSlackMutableAllowEntry as o, isIrcMutableAllowEntry as r, isZalouserMutableGroupEntry as s, isDiscordMutableAllowEntry as t };
