import { Bn as SpeechProviderPlugin } from "./types-DKA4S1yN.js";
import { n as isValidElevenLabsVoiceId } from "./shared-B2BvPHUf.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };