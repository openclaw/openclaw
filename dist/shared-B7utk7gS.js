//#region extensions/elevenlabs/shared.ts
const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
function isValidElevenLabsVoiceId(voiceId) {
	return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}
function normalizeElevenLabsBaseUrl(baseUrl) {
	return (baseUrl?.trim())?.replace(/\/+$/, "") || "https://api.elevenlabs.io";
}
//#endregion
export { isValidElevenLabsVoiceId as n, normalizeElevenLabsBaseUrl as r, DEFAULT_ELEVENLABS_BASE_URL as t };
