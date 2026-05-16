//#region extensions/discord/src/security-doctor.ts
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
//#endregion
export { isDiscordMutableAllowEntry as t };
