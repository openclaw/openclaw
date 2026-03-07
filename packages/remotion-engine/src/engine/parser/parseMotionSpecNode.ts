/**
 * Node.js-only MotionSpec file loader.
 * Use this in CLI tools (make-variants, render scripts), NOT in Remotion components.
 * For Remotion components, use parseMotionSpec() with a JSON import.
 */
import fs from "node:fs";
import path from "node:path";
import { MotionSpec } from "./MotionSpecTypes";
import { validateMotionSpec } from "./validateMotionSpec";
import { sampleDemoCadence } from "../demo/DemoFramesSampler";

export function parseMotionSpecFromFile(filePath: string): MotionSpec {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, "utf-8");
  const spec = JSON.parse(raw) as MotionSpec;

  // Normalize captions
  if (!spec.captions) {
    spec.captions = { enabled: false, style: "clean_lower", segments: [] };
  }

  // Derive demo cadence from actual frame directory
  spec.demoCadence = sampleDemoCadence(
    spec.assets.demoFrameDir,
    spec.durationInFrames,
  );

  validateMotionSpec(spec);
  return spec;
}
