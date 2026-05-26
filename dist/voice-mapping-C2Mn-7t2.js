import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/voice-call/src/voice-mapping.ts
/**
* Escape XML special characters for TwiML and other XML responses.
*/
function escapeXml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
/**
* Map of OpenAI voice names to similar Twilio Polly voices.
*/
const OPENAI_TO_POLLY_MAP = {
	alloy: "Polly.Joanna",
	echo: "Polly.Matthew",
	fable: "Polly.Amy",
	onyx: "Polly.Brian",
	nova: "Polly.Salli",
	shimmer: "Polly.Kimberly"
};
/**
* Default Polly voice when no mapping is found.
*/
const DEFAULT_POLLY_VOICE = "Polly.Joanna";
/**
* Map OpenAI voice names to Twilio Polly equivalents.
* Falls through if already a valid Polly/Google voice.
*
* @param voice - OpenAI voice name (alloy, echo, etc.) or Polly voice name
* @returns Polly voice name suitable for Twilio TwiML
*/
function mapVoiceToPolly(voice) {
	if (!voice) return DEFAULT_POLLY_VOICE;
	if (voice.startsWith("Polly.") || voice.startsWith("Google.")) return voice;
	return OPENAI_TO_POLLY_MAP[normalizeLowercaseStringOrEmpty(voice)] || "Polly.Joanna";
}
//#endregion
export { mapVoiceToPolly as n, escapeXml as t };
