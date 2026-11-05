import { crc32, deflateSync } from "node:zlib";

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

/** Distinct 1-megapixel images expose decode memory hidden by repeated tiny URLs. */
export function createHeavyContentImageSources(): string[] {
  const side = 1_024;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2; // RGB, with one PNG filter byte before each scanline.
  return Array.from({ length: 40 }, (_, image) => {
    const pixels = Buffer.alloc((side * 3 + 1) * side);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const offset = y * (side * 3 + 1) + 1 + x * 3;
        pixels[offset] = (image * 37 + (x >> 5)) & 255;
        pixels[offset + 1] = (image * 71 + (y >> 5)) & 255;
        pixels[offset + 2] = (image * 19 + ((x + y) >> 6)) & 255;
      }
    }
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(pixels)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    return `data:image/png;base64,${png.toString("base64")}`;
  });
}
