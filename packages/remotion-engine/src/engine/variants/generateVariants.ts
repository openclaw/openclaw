import fs from "node:fs";
import path from "node:path";
import { MotionSpec } from "../parser/MotionSpecTypes";
import { VARIANT_PRESETS } from "./variantPresets";

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export function generateVariants(
  baseSpec: MotionSpec,
  outDir = "../../data/datasets/cutmv/motion/specs/variants",
) {
  fs.mkdirSync(outDir, { recursive: true });

  for (const preset of VARIANT_PRESETS) {
    const v = clone(baseSpec);
    v.seed = baseSpec.seed + preset.id.length;
    v.compositionId = `${baseSpec.compositionId}_${preset.id}`;

    // Replace hook scene
    const hook = v.scenes.find((s) => s.id === "hook");
    if (hook && hook.type === "hookText") {
      hook.headlineLines = [
        { text: preset.hook[0], color: "white" },
        { text: preset.hook[1], color: "green", underline: true },
      ];
    }

    // Captions align to hook
    if (v.captions?.enabled) {
      v.captions.segments = [
        { from: 0, to: 30, text: preset.hook[0], emphasis: [] },
        { from: 30, to: 60, text: preset.hook[1], emphasis: [] },
        {
          from: 230,
          to: 260,
          text: "GENERATED IN SECONDS.",
          emphasis: ["SECONDS"],
        },
      ];
    }

    const out = path.join(outDir, `${v.compositionId}.json`);
    fs.writeFileSync(out, JSON.stringify(v, null, 2), "utf-8");
  }
}
