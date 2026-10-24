import { encodePngRgba, fillPixel } from "openclaw/plugin-sdk/media-runtime";

export { maybeLoadShellEnvForGenerationProviders } from "openclaw/plugin-sdk/test-live-auth";

export function createReferencePng(
  width: number,
  height: number,
  color: (x: number, y: number) => readonly [number, number, number, number],
): Buffer {
  const buffer = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buffer, x, y, width, ...color(x, y));
    }
  }
  return encodePngRgba(buffer, width, height);
}
