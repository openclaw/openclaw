/** Compute CRC32 checksum for a buffer (used in PNG chunk encoding). */
export declare function crc32(buf: Buffer): number;
/** Create a PNG chunk with type, data, and CRC. */
export declare function pngChunk(type: string, data: Buffer): Buffer;
/** Write a pixel to an RGBA buffer. Ignores out-of-bounds writes. */
export declare function fillPixel(buf: Buffer, x: number, y: number, width: number, r: number, g: number, b: number, a?: number): void;
/** Encode an RGBA buffer as a PNG image. */
export declare function encodePngRgba(buffer: Buffer, width: number, height: number): Buffer;
