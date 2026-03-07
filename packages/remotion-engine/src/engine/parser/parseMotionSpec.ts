import { MotionSpec } from "./MotionSpecTypes";
import { validateMotionSpec } from "./validateMotionSpec";

/**
 * Parse and validate a MotionSpec object.
 * For file loading, use direct JSON import (resolveJsonModule)
 * since Remotion's webpack bundler doesn't support node:fs.
 */
export function parseMotionSpec(raw: Record<string, unknown>): MotionSpec {
  const spec = raw as unknown as MotionSpec;

  // Normalize captions
  if (!spec.captions) {
    spec.captions = { enabled: false, style: "clean_lower", segments: [] };
  }

  // Normalize demoCadence (generate fallback beats if not present)
  if (!spec.demoCadence) {
    const dur = spec.durationInFrames || 300;
    spec.demoCadence = {
      frameCount: 0,
      beats: Array.from({ length: 10 }, (_, i) =>
        Math.round((i / 9) * (dur - 1)),
      ),
    };
  }

  validateMotionSpec(spec);
  return spec;
}
