import { L as SpeechVoiceOption } from "./tts-runtime.types-t6IPjsfU.js";
import { Vn as SpeechProviderPlugin } from "./types-DdGVOQ6y.js";
//#region extensions/microsoft/speech-provider.d.ts
declare function isCjkDominant(text: string): boolean;
declare function listMicrosoftVoices(): Promise<SpeechVoiceOption[]>;
declare function buildMicrosoftSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };