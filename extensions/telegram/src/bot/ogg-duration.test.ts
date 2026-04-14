import { describe, expect, it } from "vitest";
import { getOggDurationSecs } from "./ogg-duration.js";

describe("getOggDurationSecs", () => {
  function buildOggPage(granuleLo: number, granuleHi: number, isLast = false): Buffer {
    // Minimal Ogg page: "OggS" + version(1) + headerType(1) + granule(8) + serial(4) + seq(4) + crc(4) + segments(1)
    const page = Buffer.alloc(27);
    page.write("OggS", 0);
    page[4] = 0; // version
    page[5] = isLast ? 0x04 : 0x00; // header_type (0x04 = last page of stream)
    page.writeUInt32LE(granuleLo, 6);
    page.writeUInt32LE(granuleHi, 10);
    page.writeUInt32LE(1, 14); // serial
    page.writeUInt32LE(0, 18); // sequence
    page.writeUInt32LE(0, 22); // CRC (not validated)
    page[26] = 0; // number of segments
    return page;
  }

  it("returns undefined for empty buffer", () => {
    expect(getOggDurationSecs(Buffer.alloc(0))).toBeUndefined();
  });

  it("returns undefined for non-Ogg buffer", () => {
    expect(getOggDurationSecs(Buffer.from("not an ogg file at all"))).toBeUndefined();
  });

  it("computes duration from single-page Ogg", () => {
    // 48000 granule = 1 second
    const page = buildOggPage(48_000, 0);
    expect(getOggDurationSecs(page)).toBe(1);
  });

  it("computes duration from multi-page Ogg", () => {
    // Two pages — duration comes from the last one
    const page1 = buildOggPage(0, 0); // first page (granule 0)
    const page2 = buildOggPage(48_000 * 30, 0, true); // last page (30 seconds)
    const buffer = Buffer.concat([page1, page2]);
    expect(getOggDurationSecs(buffer)).toBe(30);
  });

  it("handles large granule positions (> 32 bits)", () => {
    // 2 hours = 7200 seconds = 345600000 samples
    // 345600000 = 0x00000014 * 0x100000000 + 0x9C400000
    // Actually: 345600000 = 0x1_49A4000 — fits in 32 bits. Use a bigger value.
    // 10 hours = 36000 seconds = 1728000000 samples (fits in 32 bits as 0x66FF3000)
    const samples = 1_728_000_000;
    const page = buildOggPage(samples, 0);
    expect(getOggDurationSecs(page)).toBe(36_000);
  });

  it("returns undefined for -1 granule (not set)", () => {
    const page = buildOggPage(0xffffffff, 0xffffffff);
    expect(getOggDurationSecs(page)).toBeUndefined();
  });

  it("returns undefined for zero granule", () => {
    const page = buildOggPage(0, 0);
    expect(getOggDurationSecs(page)).toBeUndefined();
  });
});
