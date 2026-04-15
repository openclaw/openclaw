/**
 * Re-export audio conversion utilities from engine/.
 *
 * This file used to contain the full audio-convert implementation.
 * All logic has been moved to engine/utils/audio.ts; this module
 * re-exports for backward compatibility with existing import paths.
 */

export {
  loadSilkWasm,
  pcmToWav,
  stripAmrHeader,
  convertSilkToWav,
  isVoiceAttachment,
  isAudioFile,
  shouldTranscodeVoice,
  pcmToSilk,
  audioFileToSilkBase64,
  waitForFile,
  ffmpegToPCM,
  wasmDecodeMp3ToPCM,
  parseWavFallback,
} from "../engine/utils/audio.js";
