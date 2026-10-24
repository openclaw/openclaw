import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-ffmpeg";
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

export function withPluginsEnabled(cfg: OpenClawConfig): OpenClawConfig {
  return { ...cfg, plugins: { ...cfg.plugins, enabled: true } };
}

export function hasTrustedFfmpegForLiveVoiceNote(provider: string): boolean {
  try {
    resolveFfmpegBin();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ffmpeg not found in trusted system directories")) {
      console.warn(`[${provider}:live] skip voice-note transcode: ffmpeg unavailable`);
      return false;
    }
    throw error;
  }
}
