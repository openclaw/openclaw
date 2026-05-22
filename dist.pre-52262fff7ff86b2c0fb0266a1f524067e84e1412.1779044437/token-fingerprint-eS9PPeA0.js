import { createHash } from "node:crypto";
//#region extensions/telegram/src/token-fingerprint.ts
/**
* Derive a short, non-reversible fingerprint of a Telegram bot token suitable
* for diagnostic logs and persisted-state identity checks. Two tokens for the
* same bot (e.g. after BotFather `/revoke`) share the same bot id but produce
* different fingerprints, which lets callers detect rotation without storing
* the token secret on disk.
*/
function fingerprintTelegramBotToken(token) {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
//#endregion
export { fingerprintTelegramBotToken as t };
