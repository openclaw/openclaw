import { n as splitGraphemes } from "./ansi-4r6vVvJt.js";
//#region src/terminal/decorative-emoji.ts
const EMOJI_GRAPHEME_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
function isKnownEmojiTerminal(env) {
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();
	return termProgram.includes("iterm") || termProgram.includes("apple_terminal") || termProgram.includes("ghostty") || termProgram.includes("wezterm") || termProgram.includes("vscode") || term.includes("ghostty") || term.includes("wezterm") || Boolean(env.WT_SESSION);
}
function hasUtf8Locale(env) {
	const locale = [
		env.LC_ALL,
		env.LC_CTYPE,
		env.LANG
	].find((value) => typeof value === "string" && value.trim().length > 0);
	if (!locale) return true;
	return /utf-?8/i.test(locale);
}
function supportsDecorativeEmoji(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	if (!(options.isTty ?? options.stream?.isTTY ?? process.stdout.isTTY)) return false;
	if ((env.TERM ?? "").toLowerCase() === "dumb") return false;
	if (!hasUtf8Locale(env)) return false;
	if (isKnownEmojiTerminal(env)) return true;
	if (platform === "darwin") return true;
	return false;
}
function decorativeEmoji(emoji, options = {}) {
	return supportsDecorativeEmoji(options) ? emoji : "";
}
function decorativePrefix(emoji, text, options = {}) {
	const prefix = decorativeEmoji(emoji, options);
	return prefix ? `${prefix} ${text}` : text;
}
function stripDecorativeEmojiForTerminal(text, options = {}) {
	if (supportsDecorativeEmoji(options)) return text;
	return splitGraphemes(text).filter((grapheme) => !EMOJI_GRAPHEME_PATTERN.test(grapheme)).join("").replace(/\s{2,}/g, " ").trim();
}
//#endregion
export { supportsDecorativeEmoji as i, decorativePrefix as n, stripDecorativeEmojiForTerminal as r, decorativeEmoji as t };
