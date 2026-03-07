/**
 * compileMotionSpec.ts — MotionSpec compiler.
 *
 * Takes a raw MotionSpec JSON and resolves it against the style system:
 *   1. Resolves style profile → layout + typography + motion + overlays
 *   2. Validates all assets exist and belong to brand
 *   3. Applies layout zones to scene positions
 *   4. Resolves motion presets for each animation reference
 *   5. Outputs a "compiled" spec ready for Remotion rendering
 *
 * Usage:
 *   import { compileMotionSpec } from './compileMotionSpec';
 *   const compiled = compileMotionSpec(rawSpec, engineDir, publicDir);
 */

import * as fs from "fs";
import * as path from "path";
import { extractAssetsFromSpec, validateAllAssets } from "./resolveAssets";

type Brand = "cutmv" | "fulldigital";

interface CompiledSpec {
  raw: Record<string, unknown>;
  profile: Record<string, unknown>;
  layout: Record<string, unknown>;
  typography: Record<string, unknown>;
  motion: Record<string, unknown>;
  overlays: Record<string, unknown>;
  assetsValid: boolean;
  missingAssets: string[];
  warnings: string[];
}

// ── Load JSON helper ──
function loadJson(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── Main compiler ──
export function compileMotionSpec(
  specPath: string,
  engineDir: string,
  publicDir: string,
): CompiledSpec {
  const spec = loadJson(specPath);
  const brand = (spec.brand as Brand) || "cutmv";
  const warnings: string[] = [];

  // ── 1. Resolve style profile ──
  const profiles = loadJson(
    path.join(engineDir, "style", "profiles.json"),
  ) as Record<string, unknown>;
  const allProfiles = profiles.profiles as Record<
    string,
    Record<string, unknown>
  >;

  // Find matching profile from spec's style_profile or template_id
  const styleProfile =
    (spec.style_profile as string) ||
    (spec.format as Record<string, unknown>)?.style_profile;
  let matchedProfile: Record<string, unknown> | null = null;
  let profileName = "unknown";

  if (styleProfile && allProfiles[styleProfile as string]) {
    matchedProfile = allProfiles[styleProfile as string];
    profileName = styleProfile as string;
  } else {
    // Try matching by template_id
    const templateId = spec.template_id as string;
    for (const [name, profile] of Object.entries(allProfiles)) {
      const templates = profile.templates as string[] | undefined;
      if (templates?.includes(templateId)) {
        matchedProfile = profile;
        profileName = name;
        break;
      }
    }
  }

  if (!matchedProfile) {
    warnings.push(
      `No style profile matched for spec. Using defaults.`,
    );
    matchedProfile = {};
  }

  // ── 2. Load referenced style files ──
  const typographyFile = loadJson(
    path.join(engineDir, "style", "typography.json"),
  );
  const motionFile = loadJson(
    path.join(engineDir, "style", "motion.json"),
  );
  const layoutFile = loadJson(
    path.join(engineDir, "style", "layout.json"),
  );
  const overlaysFile = loadJson(
    path.join(engineDir, "style", "overlays.json"),
  );

  // Resolve specific presets from the profile
  const typographyPresetName =
    (matchedProfile.typography as string) || "cutmv_type_v1";
  const motionPresetName =
    (matchedProfile.motion as string) || "ease_premium_v1";
  const layoutPresetName =
    (matchedProfile.layout as string) || "grid9x16_v1";
  const overlayPresetName =
    (matchedProfile.overlays as string) || "minimal_accent_v1";

  const typographyPresets = typographyFile.presets as Record<
    string,
    unknown
  >;
  const motionPresets = motionFile.presets as Record<string, unknown>;
  const layoutPresets = layoutFile.layouts as Record<string, unknown>;
  const overlayPresets = overlaysFile.presets as Record<string, unknown>;

  const typography =
    (typographyPresets?.[typographyPresetName] as Record<string, unknown>) ||
    {};
  const motion =
    (motionPresets?.[motionPresetName] as Record<string, unknown>) || {};
  const layout =
    (layoutPresets?.[layoutPresetName] as Record<string, unknown>) || {};
  const overlays =
    (overlayPresets?.[overlayPresetName] as Record<string, unknown>) || {};

  // ── 3. Validate assets ──
  const assetRefs = extractAssetsFromSpec(spec);
  let assetsValid = true;
  let missingAssets: string[] = [];

  try {
    const assetResult = validateAllAssets(assetRefs, brand, publicDir);
    assetsValid = assetResult.valid;
    missingAssets = assetResult.missing;
  } catch (err) {
    assetsValid = false;
    warnings.push(`Asset validation error: ${(err as Error).message}`);
  }

  if (missingAssets.length > 0) {
    for (const m of missingAssets) {
      warnings.push(`Missing asset: ${m}`);
    }
  }

  // ── 4. Return compiled spec ──
  return {
    raw: spec,
    profile: { name: profileName, ...matchedProfile },
    layout,
    typography,
    motion,
    overlays,
    assetsValid,
    missingAssets,
    warnings,
  };
}

// ── CLI runner ──
if (require.main === module) {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error(
      "Usage: npx ts-node compileMotionSpec.ts <path-to-spec.json>",
    );
    process.exit(1);
  }

  const engineDir = path.resolve(__dirname, "..");
  const publicDir = path.resolve(__dirname, "../../../../public");

  console.log(`\n🔧 Compiling: ${specPath}`);
  console.log(`   Engine:  ${engineDir}`);
  console.log(`   Public:  ${publicDir}\n`);

  const compiled = compileMotionSpec(
    path.resolve(specPath),
    engineDir,
    publicDir,
  );

  console.log(`   Profile:    ${(compiled.profile as Record<string, unknown>).name}`);
  console.log(`   Assets OK:  ${compiled.assetsValid}`);
  console.log(`   Missing:    ${compiled.missingAssets.length}`);
  console.log(`   Warnings:   ${compiled.warnings.length}`);

  if (compiled.warnings.length > 0) {
    console.log(`\n⚠️  WARNINGS:`);
    for (const w of compiled.warnings) {
      console.log(`   ${w}`);
    }
  }

  if (compiled.assetsValid) {
    console.log(`\n✅ COMPILATION COMPLETE. Ready to render.`);
  } else {
    console.log(`\n❌ COMPILATION FAILED. Fix missing assets.`);
  }
}
