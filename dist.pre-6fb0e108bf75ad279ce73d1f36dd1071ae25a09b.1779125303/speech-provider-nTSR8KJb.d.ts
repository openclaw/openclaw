import { L as SpeechVoiceOption } from "./tts-runtime.types-B3dymhrC.js";
import { Gn as SpeechProviderPlugin } from "./types-CPAF_tyr.js";
//#region extensions/microsoft/speech-provider.d.ts
declare function isCjkDominant(text: string): boolean;
declare function listMicrosoftVoices(): Promise<SpeechVoiceOption[]>;
declare function buildMicrosoftSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };