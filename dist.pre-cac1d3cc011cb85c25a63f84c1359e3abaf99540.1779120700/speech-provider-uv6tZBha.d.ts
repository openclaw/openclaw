import { Gn as SpeechProviderPlugin } from "./types-UTp4ves_.js";
import { n as isValidElevenLabsVoiceId } from "./shared-ycsekAzX.js";

//#region extensions/elevenlabs/speech-provider.d.ts
declare const isValidVoiceId: typeof isValidElevenLabsVoiceId;
declare function buildElevenLabsSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };