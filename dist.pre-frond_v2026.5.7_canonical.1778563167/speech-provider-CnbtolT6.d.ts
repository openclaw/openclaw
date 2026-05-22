import { Bn as SpeechProviderPlugin } from "./types-D40p5jC7.js";
import { n as isValidElevenLabsVoiceId } from "./shared-DnZtPZT5.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };