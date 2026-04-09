/**
 * G.722 SB-ADPCM Decoder — Pure TypeScript
 *
 * Ported from the ITU-T reference implementation (libg722 by Steve Underwood).
 * Original code is public domain (CMU 1993 / Steve Underwood 2005).
 *
 * G.722 decodes 64kbps compressed audio into 16kHz 16-bit PCM.
 * Each input byte produces 2 output samples (16-bit signed, little-endian).
 * 160 bytes in → 320 samples → 640 bytes PCM16 @ 16kHz.
 */

// Lookup tables from ITU-T G.722 specification

const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042];
const RL42 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0];
const ILB = [
  2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599,
  2656, 2714, 2774, 2834, 2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371,
  3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008,
];
const WH = [0, -214, 798];
const RH2 = [2, 1, 2, 1];
const QM2 = [-7408, -1616, 7408, 1616];
const QM4 = [
  0, -20456, -12896, -8968, -6288, -4240, -2584, -1200, 20456, 12896, 8968,
  6288, 4240, 2584, 1200, 0,
];
const QM6 = [
  -136, -136, -136, -136, -24808, -21904, -19008, -16704, -14984, -13512,
  -12280, -11192, -10232, -9360, -8576, -7856, -7192, -6576, -6000, -5456,
  -4944, -4464, -4008, -3576, -3168, -2776, -2400, -2032, -1688, -1360, -1040,
  -728, 24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192, 10232, 9360,
  8576, 7856, 7192, 6576, 6000, 5456, 4944, 4464, 4008, 3576, 3168, 2776,
  2400, 2032, 1688, 1360, 1040, 728, 432, 136, -432, -136,
];
const QMF_COEFFS = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11];

function saturate(amp: number): number {
  if (amp > 32767) return 32767;
  if (amp < -32768) return -32768;
  return amp;
}

interface Band {
  s: number;
  sp: number;
  sz: number;
  r: number[];
  a: number[];
  ap: number[];
  p: number[];
  d: number[];
  b: number[];
  bp: number[];
  sg: number[];
  nb: number;
  det: number;
}

function makeBand(det: number): Band {
  return {
    s: 0,
    sp: 0,
    sz: 0,
    r: [0, 0, 0],
    a: [0, 0, 0],
    ap: [0, 0, 0],
    p: [0, 0, 0],
    d: [0, 0, 0, 0, 0, 0, 0],
    b: [0, 0, 0, 0, 0, 0, 0],
    bp: [0, 0, 0, 0, 0, 0, 0],
    sg: [0, 0, 0, 0, 0, 0, 0],
    nb: 0,
    det,
  };
}

function block4(band: Band, d: number): void {
  band.d[0] = d;
  band.r[0] = saturate(band.s + d);
  band.p[0] = saturate(band.sz + d);

  // UPPOL2
  for (let i = 0; i < 3; i++) band.sg[i] = band.p[i] >> 15;
  let wd1 = saturate(band.a[1] << 2);
  let wd2 = band.sg[0] === band.sg[1] ? -wd1 : wd1;
  if (wd2 > 32767) wd2 = 32767;
  let wd3 = (wd2 >> 7) + (band.sg[0] === band.sg[2] ? 128 : -128);
  wd3 += (band.a[2] * 32512) >> 15;
  if (wd3 > 12288) wd3 = 12288;
  else if (wd3 < -12288) wd3 = -12288;
  band.ap[2] = wd3;

  // UPPOL1
  band.sg[0] = band.p[0] >> 15;
  band.sg[1] = band.p[1] >> 15;
  wd1 = band.sg[0] === band.sg[1] ? 192 : -192;
  wd2 = (band.a[1] * 32640) >> 15;
  band.ap[1] = saturate(wd1 + wd2);
  wd3 = saturate(15360 - band.ap[2]);
  if (band.ap[1] > wd3) band.ap[1] = wd3;
  else if (band.ap[1] < -wd3) band.ap[1] = -wd3;

  // UPZERO
  wd1 = d === 0 ? 0 : 128;
  band.sg[0] = d >> 15;
  for (let i = 1; i < 7; i++) {
    band.sg[i] = band.d[i] >> 15;
    wd2 = band.sg[i] === band.sg[0] ? wd1 : -wd1;
    wd3 = (band.b[i] * 32640) >> 15;
    band.bp[i] = saturate(wd2 + wd3);
  }

  // DELAYA
  for (let i = 6; i > 0; i--) {
    band.d[i] = band.d[i - 1];
    band.b[i] = band.bp[i];
  }
  for (let i = 2; i > 0; i--) {
    band.r[i] = band.r[i - 1];
    band.p[i] = band.p[i - 1];
    band.a[i] = band.ap[i];
  }

  // FILTEP
  wd1 = saturate(band.r[1] + band.r[1]);
  wd1 = (band.a[1] * wd1) >> 15;
  wd2 = saturate(band.r[2] + band.r[2]);
  wd2 = (band.a[2] * wd2) >> 15;
  band.sp = saturate(wd1 + wd2);

  // FILTEZ
  band.sz = 0;
  for (let i = 6; i > 0; i--) {
    wd1 = saturate(band.d[i] + band.d[i]);
    band.sz += (band.b[i] * wd1) >> 15;
  }
  band.sz = saturate(band.sz);

  // PREDIC
  band.s = saturate(band.sp + band.sz);
}

/**
 * Stateful G.722 decoder.
 * Create one per call — maintains adaptive filter state across frames.
 */
export class G722Decoder {
  private band: [Band, Band];
  private x: number[];

  constructor() {
    this.band = [makeBand(32), makeBand(8)];
    this.x = new Array(24).fill(0);
  }

  /**
   * Decode G.722 data to 16-bit signed PCM @ 16kHz.
   *
   * @param g722Data Raw G.722 bytes (64kbps mode, unpacked)
   * @returns Buffer of signed 16-bit little-endian PCM samples at 16kHz.
   *          Output length = input length * 4 bytes (1 byte → 2 samples × 2 bytes each).
   */
  decode(g722Data: Buffer): Buffer {
    const len = g722Data.length;
    // Each input byte produces 2 output samples (16-bit each)
    const output = Buffer.alloc(len * 4);
    let outIdx = 0;

    for (let j = 0; j < len; j++) {
      const code = g722Data[j];

      // 8 bits per sample (64kbps mode): low 6 bits = low band, high 2 bits = high band
      const wd1Low = code & 0x3f;
      const ihigh = (code >> 6) & 0x03;
      const wd2Low = QM6[wd1Low];
      const wd1Quant = wd1Low >> 2;

      // Block 5L: LOW BAND INVQBL
      let wd2 = (this.band[0].det * wd2Low) >> 15;
      // Block 5L: RECONS
      let rlow = this.band[0].s + wd2;
      if (rlow > 16383) rlow = 16383;
      else if (rlow < -16384) rlow = -16384;

      // Block 2L: INVQAL
      const dlowt = (this.band[0].det * QM4[wd1Quant]) >> 15;

      // Block 3L: LOGSCL
      wd2 = RL42[wd1Quant];
      let wd1 = (this.band[0].nb * 127) >> 7;
      wd1 += WL[wd2];
      if (wd1 < 0) wd1 = 0;
      else if (wd1 > 18432) wd1 = 18432;
      this.band[0].nb = wd1;

      // Block 3L: SCALEL
      wd1 = (this.band[0].nb >> 6) & 31;
      wd2 = 8 - (this.band[0].nb >> 11);
      const wd3Low = wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2;
      this.band[0].det = wd3Low << 2;

      block4(this.band[0], dlowt);

      // High band decode
      const dhigh = (this.band[1].det * QM2[ihigh]) >> 15;
      let rhigh = dhigh + this.band[1].s;
      if (rhigh > 16383) rhigh = 16383;
      else if (rhigh < -16384) rhigh = -16384;

      wd2 = RH2[ihigh];
      wd1 = (this.band[1].nb * 127) >> 7;
      wd1 += WH[wd2];
      if (wd1 < 0) wd1 = 0;
      else if (wd1 > 22528) wd1 = 22528;
      this.band[1].nb = wd1;

      // Block 3H: SCALEH
      wd1 = (this.band[1].nb >> 6) & 31;
      wd2 = 10 - (this.band[1].nb >> 11);
      const wd3High = wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2;
      this.band[1].det = wd3High << 2;

      block4(this.band[1], dhigh);

      // QMF synthesis filter — reconstruct 16kHz from low + high sub-bands
      for (let i = 0; i < 22; i++) this.x[i] = this.x[i + 2];
      this.x[22] = rlow + rhigh;
      this.x[23] = rlow - rhigh;

      let xout1 = 0;
      let xout2 = 0;
      for (let i = 0; i < 12; i++) {
        xout2 += this.x[2 * i] * QMF_COEFFS[i];
        xout1 += this.x[2 * i + 1] * QMF_COEFFS[11 - i];
      }

      // Write two 16-bit samples (little-endian)
      output.writeInt16LE(saturate(xout1 >> 11), outIdx);
      outIdx += 2;
      output.writeInt16LE(saturate(xout2 >> 11), outIdx);
      outIdx += 2;
    }

    return output;
  }
}
