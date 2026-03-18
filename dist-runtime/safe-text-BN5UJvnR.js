import { i as stripAnsi, t as init_ansi } from "./ansi-CeMmGDji.js";
//#region src/terminal/safe-text.ts
init_ansi();
/**
* Normalize untrusted text for single-line terminal/log rendering.
*/
function sanitizeTerminalText(input) {
	const normalized = stripAnsi(input).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
	let sanitized = "";
	for (const char of normalized) {
		const code = char.charCodeAt(0);
		if (!(code >= 0 && code <= 31 || code >= 127 && code <= 159)) sanitized += char;
	}
	return sanitized;
}
//#endregion
export { sanitizeTerminalText as t };
