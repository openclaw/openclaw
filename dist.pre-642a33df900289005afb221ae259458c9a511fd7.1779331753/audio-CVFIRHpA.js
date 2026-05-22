import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as getFileExtension, u as normalizeMimeType } from "./mime-DppuT-pZ.js";
//#region src/media/audio.ts
const VOICE_MESSAGE_AUDIO_EXTENSIONS = new Set([
	".oga",
	".ogg",
	".opus",
	".mp3",
	".m4a"
]);
/**
* MIME types compatible with voice messages.
*/
const VOICE_MESSAGE_MIME_TYPES = new Set([
	"audio/ogg",
	"audio/opus",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/x-m4a",
	"audio/m4a"
]);
function isVoiceMessageCompatibleAudio(opts) {
	const mime = normalizeMimeType(opts.contentType);
	if (mime && VOICE_MESSAGE_MIME_TYPES.has(mime)) return true;
	const fileName = normalizeOptionalString(opts.fileName);
	if (!fileName) return false;
	const ext = getFileExtension(fileName);
	if (!ext) return false;
	return VOICE_MESSAGE_AUDIO_EXTENSIONS.has(ext);
}
function isVoiceCompatibleAudio(opts) {
	return isVoiceMessageCompatibleAudio(opts);
}
//#endregion
export { isVoiceMessageCompatibleAudio as i, VOICE_MESSAGE_MIME_TYPES as n, isVoiceCompatibleAudio as r, VOICE_MESSAGE_AUDIO_EXTENSIONS as t };
