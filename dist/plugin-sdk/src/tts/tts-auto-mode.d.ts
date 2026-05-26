import type { TtsAutoMode } from "../config/types.tts.js";
export declare const TTS_AUTO_MODES: Set<TtsAutoMode>;
export declare function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined;
