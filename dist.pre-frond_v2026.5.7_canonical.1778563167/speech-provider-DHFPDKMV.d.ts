import { L as SpeechVoiceOption } from "./tts-runtime.types-B6N-aDGD.js";
import { Bn as SpeechProviderPlugin } from "./types-D40p5jC7.js";
//#region extensions/microsoft/speech-provider.d.ts
declare function isCjkDominant(text: string): boolean;
declare function listMicrosoftVoices(): Promise<SpeechVoiceOption[]>;
declare function buildMicrosoftSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };