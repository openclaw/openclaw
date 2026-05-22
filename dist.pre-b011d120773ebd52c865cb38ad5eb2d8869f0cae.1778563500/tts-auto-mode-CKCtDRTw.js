import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/tts/tts-auto-mode.ts
const TTS_AUTO_MODES = new Set([
	"off",
	"always",
	"inbound",
	"tagged"
]);
function normalizeTtsAutoMode(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (TTS_AUTO_MODES.has(normalized)) return normalized;
}
//#endregion
export { normalizeTtsAutoMode as n, TTS_AUTO_MODES as t };
