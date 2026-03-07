/**
 * Demo Frames Sampler — Node.js only.
 * Reads the demo frame directory to derive cadence/timing beats.
 * NEVER displays or embeds frames — only extracts beat grid for animation pacing.
 */
import fs from "node:fs";

export type DemoCadence = {
  frameCount: number;
  /** Beat frames (relative offsets) to trigger micro-animations */
  beats: number[];
};

export function sampleDemoCadence(
  demoFrameDir?: string,
  durationInFrames = 300,
): DemoCadence {
  if (!demoFrameDir) {
    // Fallback: evenly spaced beats
    return {
      frameCount: 0,
      beats: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270],
    };
  }

  let files: string[];
  try {
    files = fs
      .readdirSync(demoFrameDir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    // Directory not accessible — use fallback
    return {
      frameCount: 0,
      beats: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270],
    };
  }

  const frameCount = files.length;

  // Cadence heuristic: more frames -> more "micro-beats"
  const beatCount =
    frameCount >= 600
      ? 14
      : frameCount >= 300
        ? 12
        : frameCount >= 150
          ? 10
          : 8;

  const beats = Array.from({ length: beatCount }, (_, i) =>
    Math.round((i / (beatCount - 1)) * (durationInFrames - 1)),
  );

  return { frameCount, beats };
}
