import { L as SpeechVoiceOption } from "./tts-runtime.types-KHs4BVU8.js";
import { Bn as SpeechProviderPlugin } from "./types-ItMBrbf4.js";
//#region extensions/microsoft/speech-provider.d.ts
declare function isCjkDominant(text: string): boolean;
declare function listMicrosoftVoices(): Promise<SpeechVoiceOption[]>;
declare function buildMicrosoftSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };