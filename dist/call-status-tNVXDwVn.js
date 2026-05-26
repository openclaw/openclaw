import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./realtime-voice-D-uczs8E.js";
//#region extensions/voice-call/src/telephony-audio.ts
/**
* Chunk audio buffer into 20ms frames for streaming (8kHz mono mu-law).
*/
function chunkAudio(audio, chunkSize = 160) {
	return (function* () {
		for (let i = 0; i < audio.length; i += chunkSize) yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
	})();
}
//#endregion
//#region extensions/voice-call/src/providers/shared/call-status.ts
const TERMINAL_PROVIDER_STATUS_TO_END_REASON = {
	completed: "completed",
	failed: "failed",
	busy: "busy",
	"no-answer": "no-answer",
	canceled: "hangup-bot"
};
function normalizeProviderStatus(status) {
	const normalized = normalizeOptionalLowercaseString(status);
	return normalized && normalized.length > 0 ? normalized : "unknown";
}
function mapProviderStatusToEndReason(status) {
	return TERMINAL_PROVIDER_STATUS_TO_END_REASON[normalizeProviderStatus(status)] ?? null;
}
function isProviderStatusTerminal(status) {
	return mapProviderStatusToEndReason(status) !== null;
}
//#endregion
export { chunkAudio as i, mapProviderStatusToEndReason as n, normalizeProviderStatus as r, isProviderStatusTerminal as t };
