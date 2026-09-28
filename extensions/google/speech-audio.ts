/** Normalize unary Gemini audio to the 24 kHz mono PCM16 consumed by TTS outputs. */
export function googleSpeechPcm(audio: Buffer): Buffer {
  if (
    audio.subarray(0, 4).toString("ascii") !== "RIFF" ||
    audio.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    return audio;
  }
  const end = audio.readUInt32LE(4) + 8;
  if (end > audio.length) {
    throw new Error("Google TTS returned truncated WAV audio");
  }
  let formatValid = false;
  const chunks: Buffer[] = [];
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) {
      throw new Error("Google TTS returned truncated WAV chunk");
    }
    const tag = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) {
      throw new Error("Google TTS returned truncated WAV chunk");
    }
    if (tag === "fmt ") {
      formatValid =
        size >= 16 &&
        audio.readUInt16LE(start) === 1 &&
        audio.readUInt16LE(start + 2) === 1 &&
        audio.readUInt32LE(start + 4) === 24_000 &&
        audio.readUInt16LE(start + 12) === 2 &&
        audio.readUInt16LE(start + 14) === 16;
      if (!formatValid) {
        throw new Error("Google TTS WAV must be 24 kHz mono PCM16");
      }
    } else if (tag === "data") {
      if (size % 2 !== 0) {
        throw new Error("Google TTS returned incomplete PCM16 samples");
      }
      chunks.push(audio.subarray(start, start + size));
    }
    offset = start + size + (size % 2);
  }
  if (!formatValid || chunks.length === 0) {
    throw new Error("Google TTS WAV is missing format or audio data");
  }
  return Buffer.concat(chunks);
}
