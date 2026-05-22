//#region src/terminal/ansi.ts
const ANSI_CSI_PATTERN = "\\x1b\\[[\\x20-\\x3f]*[\\x40-\\x7e]";
const OSC8_PATTERN = "\\x1b\\]8;;.*?(?:\\x1b\\\\|\\x07)|\\x1b\\]8;;(?:\\x1b\\\\|\\x07)";
const ANSI_CSI_REGEX = new RegExp(ANSI_CSI_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
function stripAnsi(input) {
	return input.replace(OSC8_REGEX, "").replace(ANSI_CSI_REGEX, "");
}
function splitGraphemes(input) {
	if (!input) return [];
	if (!graphemeSegmenter) return Array.from(input);
	try {
		return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
	} catch {
		return Array.from(input);
	}
}
/**
* Sanitize a value for safe interpolation into log messages.
* Strips ANSI escape sequences, C0/C1 control characters, and DEL to
* prevent log forging / terminal escape injection (CWE-117).
*/
function sanitizeForLog(v) {
	const controlCharsRegex = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}${String.fromCharCode(128)}-${String.fromCharCode(159)}]`, "g");
	return stripAnsi(v).replace(controlCharsRegex, "");
}
function isZeroWidthCodePoint(codePoint) {
	return codePoint >= 768 && codePoint <= 879 || codePoint >= 6832 && codePoint <= 6911 || codePoint >= 7616 && codePoint <= 7679 || codePoint >= 8400 && codePoint <= 8447 || codePoint >= 65056 && codePoint <= 65071 || codePoint >= 65024 && codePoint <= 65039 || codePoint === 8205;
}
function isFullWidthCodePoint(codePoint) {
	if (codePoint < 4352) return false;
	return codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || codePoint >= 11904 && codePoint <= 12871 && codePoint !== 12351 || codePoint >= 12880 && codePoint <= 19903 || codePoint >= 19968 && codePoint <= 42182 || codePoint >= 43360 && codePoint <= 43388 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65040 && codePoint <= 65049 || codePoint >= 65072 && codePoint <= 65131 || codePoint >= 65281 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 110576 && codePoint <= 110579 || codePoint >= 110581 && codePoint <= 110587 || codePoint >= 110589 && codePoint <= 110590 || codePoint >= 110592 && codePoint <= 111359 || codePoint >= 127488 && codePoint <= 127569 || codePoint >= 131072 && codePoint <= 262141;
}
const emojiLikePattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
function graphemeWidth(grapheme) {
	if (!grapheme) return 0;
	if (emojiLikePattern.test(grapheme)) return 2;
	let sawPrintable = false;
	for (const char of grapheme) {
		const codePoint = char.codePointAt(0);
		if (codePoint == null) continue;
		if (isZeroWidthCodePoint(codePoint)) continue;
		if (isFullWidthCodePoint(codePoint)) return 2;
		sawPrintable = true;
	}
	return sawPrintable ? 1 : 0;
}
function visibleWidth(input) {
	return splitGraphemes(stripAnsi(input)).reduce((sum, grapheme) => sum + graphemeWidth(grapheme), 0);
}
//#endregion
export { visibleWidth as i, splitGraphemes as n, stripAnsi as r, sanitizeForLog as t };
