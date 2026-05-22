//#region src/media/png-encode.d.ts
/** Write a pixel to an RGBA buffer. Ignores out-of-bounds writes. */
declare function fillPixel(buf: Buffer, x: number, y: number, width: number, r: number, g: number, b: number, a?: number): void;
/** Encode an RGBA buffer as a PNG image. */
declare function encodePngRgba(buffer: Buffer, width: number, height: number): Buffer;
//#endregion
export { fillPixel as n, encodePngRgba as t };