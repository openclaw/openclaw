import { Gn as SpeechProviderPlugin } from "./types-Dw7_sm4q.js";
import { n as isValidElevenLabsVoiceId } from "./shared-DkwBVm73.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };