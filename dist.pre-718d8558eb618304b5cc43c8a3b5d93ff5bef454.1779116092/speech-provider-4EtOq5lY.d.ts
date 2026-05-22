import { L as SpeechVoiceOption } from "./tts-runtime.types-BcBAGmyT.js";
import { Vn as SpeechProviderPlugin } from "./types-CWJThuOe2.js";
//#region extensions/microsoft/speech-provider.d.ts
declare function isCjkDominant(text: string): boolean;
declare function listMicrosoftVoices(): Promise<SpeechVoiceOption[]>;
declare function buildMicrosoftSpeechProvider(): SpeechProviderPlugin;
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };