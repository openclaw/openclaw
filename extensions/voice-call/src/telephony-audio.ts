/** Core realtime-voice audio conversion helpers re-exported for voice-call provider code. */
export { convertPcmToMulaw8k, resamplePcmTo8k } from "openclaw/plugin-sdk/realtime-voice";

/**
 * Chunks 8kHz mono mu-law audio into streaming frames; the final frame may be shorter.
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      // Yield Buffer views instead of copies so large synthesized replies stream without extra allocation.
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}
