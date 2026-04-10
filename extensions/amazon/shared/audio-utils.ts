/** mu-law to 16-bit linear PCM conversion lookup table. */
const MULAW_TO_PCM = new Int16Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80 ? -1 : 1;
    mu &= 0x7f;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    const sample = sign * ((2 * mantissa + 33) * (1 << (exponent + 3)) - 33);
    MULAW_TO_PCM[i] = sample;
  }
})();

/**
 * Convert mu-law (G.711) audio to 16-bit signed PCM little-endian.
 * OpenClaw telephony uses mu-law; Nova Sonic expects PCM 16-bit.
 */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_TO_PCM[mulaw[i]], i * 2);
  }
  return pcm;
}

/**
 * Convert 16-bit signed PCM little-endian to mu-law (G.711).
 * Nova Sonic outputs PCM; OpenClaw telephony expects mu-law.
 */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const mulaw = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = Math.min(sample, 32635);
    sample += 0x84;

    let exponent = 7;
    for (let expMask = 0x4000; exponent > 0; exponent--, expMask >>= 1) {
      if (sample & expMask) { break; }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return mulaw;
}
