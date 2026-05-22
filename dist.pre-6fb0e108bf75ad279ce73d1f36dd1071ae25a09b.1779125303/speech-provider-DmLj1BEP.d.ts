import { Gn as SpeechProviderPlugin } from "./types-CPAF_tyr.js";
import { n as isValidElevenLabsVoiceId } from "./shared-Di0mdUHE.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };