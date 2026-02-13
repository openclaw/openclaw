export function mulawToLinear(mulaw: number): number {
  let m = ~mulaw & 0xff;
  const sign = m & 0x80;
  const exponent = (m >> 4) & 0x07;
  const mantissa = m & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

export function alawToLinear(aLaw: number): number {
  const a = aLaw ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
      break;
  }
  return a & 0x80 ? t : -t;
}

export function linearToAlaw(pcm: number): number {
  const ALAW_MAX = 0x7fff;
  let mask = 0xd5;
  let p = pcm;
  if (p < 0) {
    mask = 0x55;
    p = -p - 1;
  }
  if (p > ALAW_MAX) {
    p = ALAW_MAX;
  }
  let seg = 0;
  if (p >= 256) {
    let tmp = p >> 8;
    while (tmp) {
      seg++;
      tmp >>= 1;
    }
    seg = Math.min(seg, 7);
    const aval = (seg << 4) | ((p >> (seg + 3)) & 0x0f);
    return (aval ^ mask) & 0xff;
  }
  const aval = p >> 4;
  return (aval ^ mask) & 0xff;
}
