import { Vn as SpeechProviderPlugin } from "./types-BM0xoSYJ2.js";
import { n as isValidElevenLabsVoiceId } from "./shared-C_oEPMJo.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };