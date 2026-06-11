import fs from "node:fs/promises";
import type { BookBible } from "./types.js";

export const KDP_EBOOK_COVER_WIDTH = 1600;
export const KDP_EBOOK_COVER_HEIGHT = 2560;
export const KDP_EBOOK_COVER_MAX_BYTES = 50 * 1024 * 1024;

type Rgb = [number, number, number];

export type TiffCoverInfo = {
  width: number;
  height: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  compression: number;
  photometricInterpretation: number;
  byteLength: number;
};

const FONT: Record<string, string[]> = {
  "0": ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function setPixel(buffer: Buffer, width: number, x: number, y: number, color: Rgb): void {
  if (x < 0 || y < 0 || x >= width || y >= KDP_EBOOK_COVER_HEIGHT) {
    return;
  }
  const offset = (y * width + x) * 3;
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
}

function fillRect(
  buffer: Buffer,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Rgb,
): void {
  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));
  const endX = Math.min(width, Math.ceil(x + rectWidth));
  const endY = Math.min(KDP_EBOOK_COVER_HEIGHT, Math.ceil(y + rectHeight));
  for (let row = startY; row < endY; row += 1) {
    for (let column = startX; column < endX; column += 1) {
      setPixel(buffer, width, column, row, color);
    }
  }
}

function blendColor(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

function fillBackground(buffer: Buffer, width: number, height: number): void {
  const top: Rgb = [20, 31, 42];
  const bottom: Rgb = [60, 32, 38];
  for (let y = 0; y < height; y += 1) {
    const rowColor = blendColor(top, bottom, y / Math.max(1, height - 1));
    for (let x = 0; x < width; x += 1) {
      const vignette = Math.min(0.18, Math.abs(x - width / 2) / width);
      setPixel(buffer, width, x, y, blendColor(rowColor, [8, 12, 18], vignette));
    }
  }
}

function drawBorder(buffer: Buffer, width: number): void {
  const gold: Rgb = [229, 188, 83];
  const red: Rgb = [118, 48, 53];
  fillRect(buffer, width, 92, 92, 1416, 10, gold);
  fillRect(buffer, width, 92, 2458, 1416, 10, gold);
  fillRect(buffer, width, 92, 92, 10, 2376, gold);
  fillRect(buffer, width, 1498, 92, 10, 2376, gold);
  fillRect(buffer, width, 132, 132, 1336, 4, red);
  fillRect(buffer, width, 132, 2424, 1336, 4, red);
  fillRect(buffer, width, 132, 132, 4, 2292, red);
  fillRect(buffer, width, 1464, 132, 4, 2292, red);
}

function drawGlyph(
  buffer: Buffer,
  width: number,
  glyph: string[],
  x: number,
  y: number,
  scale: number,
  color: Rgb,
): void {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] === "1") {
        fillRect(buffer, width, x + column * scale, y + row * scale, scale, scale, color);
      }
    }
  }
}

function textWidth(text: string, scale: number): number {
  return Math.max(0, text.length * 6 * scale - scale);
}

function drawText(
  buffer: Buffer,
  width: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgb,
): void {
  const normalized = text.toUpperCase().replace(/[^A-Z0-9&'.:\-\s]/g, " ");
  let cursorX = x;
  for (const char of normalized) {
    const glyph = FONT[char] ?? FONT[" "];
    drawGlyph(buffer, width, glyph, cursorX, y, scale, color);
    cursorX += scale * 6;
  }
}

function drawCenteredText(
  buffer: Buffer,
  width: number,
  text: string,
  centerX: number,
  y: number,
  scale: number,
  color: Rgb,
): void {
  drawText(buffer, width, text, Math.round(centerX - textWidth(text, scale) / 2), y, scale, color);
}

function wrapText(input: string, maxCharacters: number): string[] {
  const words = input
    .toUpperCase()
    .replace(/[^A-Z0-9&'.:\-\s]/g, " ")
    .trim()
    .split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharacters && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines.slice(0, 5) : ["UNTITLED"];
}

function drawLedgerMark(buffer: Buffer, width: number): void {
  const paper: Rgb = [238, 226, 202];
  const ink: Rgb = [47, 58, 67];
  const accent: Rgb = [201, 76, 66];
  fillRect(buffer, width, 545, 1070, 510, 610, [14, 20, 28]);
  fillRect(buffer, width, 520, 1045, 510, 610, paper);
  fillRect(buffer, width, 560, 1090, 430, 12, ink);
  for (let index = 0; index < 9; index += 1) {
    const y = 1160 + index * 48;
    fillRect(buffer, width, 568, y, 300 + (index % 3) * 36, 8, ink);
    fillRect(buffer, width, 900, y, 56, 8, accent);
  }
  fillRect(buffer, width, 610, 1515, 260, 14, accent);
  fillRect(buffer, width, 610, 1560, 350, 8, ink);
  fillRect(buffer, width, 1070, 1535, 240, 26, [229, 188, 83]);
  fillRect(buffer, width, 1290, 1515, 28, 72, [229, 188, 83]);
}

function writeShort(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
}

function writeLong(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset);
}

function writeIfdEntry(
  header: Buffer,
  offset: number,
  tag: number,
  type: number,
  count: number,
  valueOrOffset: number,
): void {
  writeShort(header, offset, tag);
  writeShort(header, offset + 2, type);
  writeLong(header, offset + 4, count);
  if (type === 3 && count === 1) {
    writeShort(header, offset + 8, valueOrOffset);
    writeShort(header, offset + 10, 0);
  } else {
    writeLong(header, offset + 8, valueOrOffset);
  }
}

function buildTiff(rgb: Buffer, width: number, height: number): Buffer {
  const entryCount = 13;
  const ifdOffset = 8;
  const ifdLength = 2 + entryCount * 12 + 4;
  const bitsOffset = ifdOffset + ifdLength;
  const xResolutionOffset = bitsOffset + 6;
  const yResolutionOffset = xResolutionOffset + 8;
  const imageOffset = yResolutionOffset + 8;
  const header = Buffer.alloc(imageOffset);
  header.write("II", 0, "ascii");
  writeShort(header, 2, 42);
  writeLong(header, 4, ifdOffset);
  writeShort(header, ifdOffset, entryCount);
  let cursor = ifdOffset + 2;
  const writeEntry = (tag: number, type: number, count: number, valueOrOffset: number) => {
    writeIfdEntry(header, cursor, tag, type, count, valueOrOffset);
    cursor += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 3, bitsOffset);
  writeEntry(259, 3, 1, 1);
  writeEntry(262, 3, 1, 2);
  writeEntry(273, 4, 1, imageOffset);
  writeEntry(277, 3, 1, 3);
  writeEntry(278, 4, 1, height);
  writeEntry(279, 4, 1, rgb.byteLength);
  writeEntry(282, 5, 1, xResolutionOffset);
  writeEntry(283, 5, 1, yResolutionOffset);
  writeEntry(284, 3, 1, 1);
  writeEntry(296, 3, 1, 2);
  writeLong(header, cursor, 0);

  writeShort(header, bitsOffset, 8);
  writeShort(header, bitsOffset + 2, 8);
  writeShort(header, bitsOffset + 4, 8);
  writeLong(header, xResolutionOffset, 72);
  writeLong(header, xResolutionOffset + 4, 1);
  writeLong(header, yResolutionOffset, 72);
  writeLong(header, yResolutionOffset + 4, 1);

  return Buffer.concat([header, rgb]);
}

export function buildCoverTiff(bible: BookBible): Buffer {
  const width = KDP_EBOOK_COVER_WIDTH;
  const height = KDP_EBOOK_COVER_HEIGHT;
  const rgb = Buffer.alloc(width * height * 3);
  fillBackground(rgb, width, height);
  drawBorder(rgb, width);
  fillRect(rgb, width, 220, 455, 1160, 18, [229, 188, 83]);
  fillRect(rgb, width, 280, 1870, 1040, 12, [229, 188, 83]);
  fillRect(rgb, width, 250, 1930, 1100, 150, [88, 37, 45]);
  drawLedgerMark(rgb, width);

  const titleLines = wrapText(bible.title, 13);
  const titleScale = Math.max(
    11,
    Math.min(26, ...titleLines.map((line) => Math.floor(1220 / 6 / Math.max(1, line.length)))),
  );
  const titleStart = 560 - ((titleLines.length - 1) * titleScale * 9) / 2;
  titleLines.forEach((line, index) => {
    drawCenteredText(
      rgb,
      width,
      line,
      width / 2,
      Math.round(titleStart + index * titleScale * 9),
      titleScale,
      [248, 246, 238],
    );
  });

  const subtitleLines = wrapText(bible.subtitle, 22);
  subtitleLines.slice(0, 2).forEach((line, index) => {
    drawCenteredText(rgb, width, line, width / 2, 1968 + index * 92, 12, [229, 188, 83]);
  });
  drawCenteredText(rgb, width, bible.penName, width / 2, 2230, 16, [248, 246, 238]);
  return buildTiff(rgb, width, height);
}

function readShort(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readLong(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

export function readTiffCoverInfo(buffer: Buffer): TiffCoverInfo | undefined {
  if (buffer.byteLength < 16 || buffer.subarray(0, 2).toString("ascii") !== "II") {
    return undefined;
  }
  if (readShort(buffer, 2) !== 42) {
    return undefined;
  }
  const ifdOffset = readLong(buffer, 4);
  const entryCount = readShort(buffer, ifdOffset);
  const tags = new Map<number, { type: number; count: number; value: number }>();
  for (let index = 0; index < entryCount; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = readShort(buffer, offset);
    const type = readShort(buffer, offset + 2);
    const count = readLong(buffer, offset + 4);
    const value =
      type === 3 && count === 1 ? readShort(buffer, offset + 8) : readLong(buffer, offset + 8);
    tags.set(tag, { type, count, value });
  }

  const bitsTag = tags.get(258);
  const bitsPerSample =
    bitsTag?.type === 3 && bitsTag.count === 3
      ? [
          readShort(buffer, bitsTag.value),
          readShort(buffer, bitsTag.value + 2),
          readShort(buffer, bitsTag.value + 4),
        ]
      : [bitsTag?.value ?? 0];
  return {
    width: tags.get(256)?.value ?? 0,
    height: tags.get(257)?.value ?? 0,
    bitsPerSample,
    samplesPerPixel: tags.get(277)?.value ?? 0,
    compression: tags.get(259)?.value ?? 0,
    photometricInterpretation: tags.get(262)?.value ?? 0,
    byteLength: buffer.byteLength,
  };
}

export async function readTiffCoverInfoFromFile(
  filePath: string,
): Promise<TiffCoverInfo | undefined> {
  return readTiffCoverInfo(await fs.readFile(filePath));
}

export function isKdpReadyTiffCover(info: TiffCoverInfo | undefined): boolean {
  return Boolean(
    info &&
    info.width >= 625 &&
    info.height >= 1000 &&
    info.width <= 10_000 &&
    info.height <= 10_000 &&
    info.height / Math.max(1, info.width) >= 1.6 &&
    info.bitsPerSample.length === 3 &&
    info.bitsPerSample.every((bits) => bits === 8) &&
    info.samplesPerPixel === 3 &&
    info.compression === 1 &&
    info.photometricInterpretation === 2 &&
    info.byteLength < KDP_EBOOK_COVER_MAX_BYTES,
  );
}
