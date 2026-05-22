import { Bn as SpeechProviderPlugin } from "./types-CT4HF0Ri.js";
import { n as isValidElevenLabsVoiceId } from "./shared-BTg0yWuu.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };