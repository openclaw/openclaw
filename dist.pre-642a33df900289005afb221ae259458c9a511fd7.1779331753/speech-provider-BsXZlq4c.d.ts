import { L as SpeechVoiceOption } from "./tts-runtime.types-2BeY9xBR.js";
import { Gn as SpeechProviderPlugin } from "./types-DolEO2Jl.js";
//#region extensions/microsoft/speech-provider.d.ts
declare function isCjkDominant(text: string): boolean;
declare function listMicrosoftVoices(): Promise<SpeechVoiceOption[]>;
declare function buildMicrosoftSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };