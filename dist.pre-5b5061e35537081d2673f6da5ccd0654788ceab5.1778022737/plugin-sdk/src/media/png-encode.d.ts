/** Write a pixel to an RGBA buffer. Ignores out-of-bounds writes. */
export declare function fillPixel(buf: Buffer, x: number, y: number, width: number, r: number, g: number, b: number, a?: number): void;
/** Encode an RGBA buffer as a PNG image. */
export declare function encodePngRgba(buffer: Buffer, width: number, height: number): Buffer;
