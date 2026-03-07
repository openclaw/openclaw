/**
 * demoCadence — Beat-grid scheduling for UI micro-interactions.
 *
 * Two modes:
 * 1. "cadenceOnly" — Use spec.demoCadence.beats[] as the beat grid
 *    (pre-computed or human-authored beat timings).
 * 2. "auto" — Generate a beat grid from scene structure:
 *    - Scene cuts become major beats
 *    - Sub-beats distribute evenly within scenes
 *
 * The beat grid drives:
 * - Click/tap moments (align propsTimeline keyframes to beats)
 * - Camera emphasis frames
 * - Micro text pops
 * - UI highlight pulses
 *
 * This is how you get "real edit" rhythm without showing actual demo frames.
 */
import type { MotionSpec, DemoCadence, SceneSpec } from "../parser/MotionSpecTypes";

/**
 * Generate a beat grid from spec structure.
 *
 * Major beats = scene starts + scene midpoints
 * Minor beats = evenly spaced within scenes
 *
 * @param spec - The full MotionSpec
 * @param subBeatInterval - Frames between sub-beats (default: 16 ≈ 0.53s @ 30fps)
 * @returns DemoCadence with sorted, deduplicated beat frames
 */
export function generateBeatGrid(
  spec: MotionSpec,
  subBeatInterval: number = 16,
): DemoCadence {
  const beats = new Set<number>();

  for (const scene of spec.scenes) {
    // Major beat: scene start
    beats.add(scene.from);

    // Major beat: scene midpoint
    beats.add(scene.from + Math.round(scene.duration / 2));

    // Sub-beats: evenly within the scene
    const start = scene.from;
    const end = scene.from + scene.duration;
    for (let f = start + subBeatInterval; f < end; f += subBeatInterval) {
      beats.add(f);
    }
  }

  const sorted = [...beats].sort((a, b) => a - b);

  return {
    frameCount: spec.durationInFrames,
    beats: sorted,
  };
}

/**
 * Get the beat grid for a spec — uses spec.demoCadence if provided,
 * otherwise auto-generates from scene structure.
 */
export function resolveBeatGrid(spec: MotionSpec): DemoCadence {
  if (spec.demoCadence && spec.demoCadence.beats.length > 0) {
    return spec.demoCadence;
  }
  return generateBeatGrid(spec);
}

/**
 * Find the nearest beat to a given frame.
 * Useful for snapping click timings to the beat grid.
 */
export function nearestBeat(beats: number[], frame: number): number {
  if (beats.length === 0) return frame;

  let closest = beats[0];
  let minDist = Math.abs(frame - closest);

  for (let i = 1; i < beats.length; i++) {
    const dist = Math.abs(frame - beats[i]);
    if (dist < minDist) {
      minDist = dist;
      closest = beats[i];
    }
    // beats are sorted, so once we start moving away we can stop
    if (beats[i] > frame && dist > minDist) break;
  }

  return closest;
}

/**
 * Get beats within a scene's range.
 * Useful for scheduling in-scene interactions.
 */
export function beatsInScene(
  beats: number[],
  scene: SceneSpec,
): number[] {
  const start = scene.from;
  const end = scene.from + scene.duration;
  return beats.filter((b) => b >= start && b < end);
}

/**
 * Get beats within a scene, as scene-local frame offsets (0-based).
 * These map directly to propsTimeline "at" values.
 */
export function localBeatsInScene(
  beats: number[],
  scene: SceneSpec,
): number[] {
  return beatsInScene(beats, scene).map((b) => b - scene.from);
}

/**
 * Schedule N interaction moments within a scene, evenly spaced on beat grid.
 * Returns scene-local frame offsets for use in propsTimeline.
 *
 * Example: scheduleInteractions(beats, scene, 4) → [12, 28, 44, 60]
 * (4 evenly-spaced beats within the scene)
 */
export function scheduleInteractions(
  beats: number[],
  scene: SceneSpec,
  count: number,
  options: {
    /** Skip first N frames of scene (for enter animation) */
    enterBuffer?: number;
    /** Skip last N frames of scene (for exit animation + transition) */
    exitBuffer?: number;
  } = {},
): number[] {
  const enterBuf = options.enterBuffer ?? 14;
  const exitBuf = options.exitBuffer ?? 16;

  const available = beatsInScene(beats, scene).filter(
    (b) =>
      b >= scene.from + enterBuf &&
      b <= scene.from + scene.duration - exitBuf,
  );

  if (available.length === 0) return [];
  if (available.length <= count) {
    return available.map((b) => b - scene.from);
  }

  // Evenly sample from available beats
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (available.length - 1)) / Math.max(1, count - 1));
    result.push(available[idx] - scene.from);
  }

  return result;
}
