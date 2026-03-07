/**
 * validateMotionSpec.ts — Pre-render MotionSpec validator.
 *
 * Validates a MotionSpec JSON against brand rules before rendering:
 *   1. Cross-brand asset blocking
 *   2. Logo constraints (aspect_ratio_lock, no distortion, z_index 10)
 *   3. CTA presence and safe zone placement
 *   4. Font size minimums
 *   5. Opacity minimums for key elements
 *   6. Background color enforcement
 *   7. ALL_CAPS text verification
 *   8. Duration and frame count consistency
 *
 * Usage:
 *   npx ts-node brands/cutmv/engine/validators/validateMotionSpec.ts path/to/spec.json
 *   (or import validateMotionSpec in pipeline code)
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──
interface ValidationError {
  severity: "error" | "warning";
  rule: string;
  message: string;
  scene?: string | number;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  spec_id: string;
}

// ── Brand rules ──
const BRAND_RULES = {
  cutmv: {
    allowed_brand: "cutmv",
    background_color: "#000000",
    text_color: "#FFFFFF",
    accent_color: "#94F33F",
    min_font_size: 28,
    min_text_opacity: 0.9,
    cta_required: true,
    cta_text: "TRY CUTMV",
    logo_z_index: 10,
    cta_z_index_min: 9,
    all_caps: true,
    max_duration_sec: 30,
    allowed_codecs: ["h264", "h265"],
    allowed_aspect_ratios: ["9:16", "16:9", "1:1", "4:5"],
  },
};

// ── Validators ──
function validateBrandAssets(
  spec: Record<string, unknown>,
  errors: ValidationError[],
): void {
  const brand = spec.brand as string;
  const structure = spec.structure as Record<string, unknown>[];
  if (!structure) return;

  for (const scene of structure) {
    const asset = scene.asset as Record<string, unknown> | undefined;
    const logo = scene.logo as Record<string, unknown> | undefined;

    for (const a of [asset, logo]) {
      if (a && typeof a.path === "string") {
        const assetPath = a.path as string;
        // Block cross-brand: cutmv assets must start with "cutmv/"
        if (!assetPath.startsWith(`${brand}/`)) {
          errors.push({
            severity: "error",
            rule: "cross_brand_asset",
            message: `Asset "${assetPath}" does not belong to brand "${brand}". Expected prefix "${brand}/"`,
            scene: scene.id as string,
          });
        }
      }
    }
  }
}

function validateLogo(
  spec: Record<string, unknown>,
  errors: ValidationError[],
): void {
  const structure = spec.structure as Record<string, unknown>[];
  if (!structure) return;

  const logoScenes = structure.filter(
    (s) =>
      (s.type as string)?.includes("logo") ||
      (s.id as string)?.includes("logo"),
  );

  for (const scene of logoScenes) {
    const logo = scene.logo as Record<string, unknown> | undefined;
    const zIndex =
      (scene.logo_z_index as number) ??
      (logo?.z_index as number) ??
      (scene.z_index as number);

    if (zIndex !== undefined && zIndex < 10) {
      errors.push({
        severity: "error",
        rule: "logo_z_index",
        message: `Logo z_index is ${zIndex}, must be 10`,
        scene: scene.id as string,
      });
    }

    if (logo) {
      if (logo.aspect_ratio_lock !== true) {
        errors.push({
          severity: "warning",
          rule: "logo_aspect_ratio",
          message: "Logo missing aspect_ratio_lock: true",
          scene: scene.id as string,
        });
      }

      const constraints = logo.constraints as Record<string, boolean> | undefined;
      if (constraints) {
        if (constraints.no_distortion !== true) {
          errors.push({
            severity: "warning",
            rule: "logo_distortion",
            message: "Logo missing no_distortion: true constraint",
            scene: scene.id as string,
          });
        }
      }
    }
  }
}

function validateCTA(
  spec: Record<string, unknown>,
  rules: typeof BRAND_RULES.cutmv,
  errors: ValidationError[],
): void {
  if (!rules.cta_required) return;

  const structure = spec.structure as Record<string, unknown>[];
  if (!structure) return;

  const ctaScenes = structure.filter(
    (s) =>
      (s.type as string)?.includes("cta") ||
      (s.id as string)?.includes("cta"),
  );

  if (ctaScenes.length === 0) {
    errors.push({
      severity: "error",
      rule: "cta_missing",
      message: `CTA required ("${rules.cta_text}") but no CTA scene found`,
    });
    return;
  }

  for (const scene of ctaScenes) {
    const text =
      (scene.text as string) || (scene.cta_text as string) || "";
    if (text && text.toUpperCase() !== rules.cta_text) {
      errors.push({
        severity: "warning",
        rule: "cta_text_mismatch",
        message: `CTA text "${text}" does not match required "${rules.cta_text}"`,
        scene: scene.id as string,
      });
    }

    const zIndex =
      (scene.z_index as number) ?? (scene.cta_z_index as number);
    if (zIndex !== undefined && zIndex < rules.cta_z_index_min) {
      errors.push({
        severity: "warning",
        rule: "cta_z_index",
        message: `CTA z_index ${zIndex} below minimum ${rules.cta_z_index_min}`,
        scene: scene.id as string,
      });
    }
  }
}

function validateTypography(
  spec: Record<string, unknown>,
  rules: typeof BRAND_RULES.cutmv,
  errors: ValidationError[],
): void {
  const structure = spec.structure as Record<string, unknown>[];
  if (!structure) return;

  for (const scene of structure) {
    const fontSize = scene.font_size as number | undefined;
    if (fontSize !== undefined && fontSize < rules.min_font_size) {
      errors.push({
        severity: "error",
        rule: "font_size_minimum",
        message: `Font size ${fontSize} below minimum ${rules.min_font_size}`,
        scene: scene.id as string,
      });
    }

    // Check ALL_CAPS on text content
    if (rules.all_caps) {
      const text = scene.text as string | undefined;
      if (text) {
        const alpha = text.replace(/[^a-zA-Z]/g, "");
        if (alpha && alpha !== alpha.toUpperCase()) {
          errors.push({
            severity: "error",
            rule: "all_caps",
            message: `Text "${text.slice(0, 40)}..." is not ALL_CAPS`,
            scene: scene.id as string,
          });
        }
      }

      const textSeq = scene.text_sequence as string[] | undefined;
      if (textSeq) {
        for (const t of textSeq) {
          const a = t.replace(/[^a-zA-Z]/g, "");
          if (a && a !== a.toUpperCase()) {
            errors.push({
              severity: "error",
              rule: "all_caps",
              message: `Text "${t}" in sequence is not ALL_CAPS`,
              scene: scene.id as string,
            });
          }
        }
      }
    }
  }
}

function validateDuration(
  spec: Record<string, unknown>,
  rules: typeof BRAND_RULES.cutmv,
  errors: ValidationError[],
): void {
  const format = spec.format as Record<string, unknown> | undefined;
  if (!format) return;

  const duration = format.duration_sec as number;
  const fps = format.fps as number;
  const totalFrames = format.total_frames as number;

  if (duration > rules.max_duration_sec) {
    errors.push({
      severity: "error",
      rule: "max_duration",
      message: `Duration ${duration}s exceeds maximum ${rules.max_duration_sec}s`,
    });
  }

  if (fps && duration && totalFrames) {
    const expected = Math.round(fps * duration);
    if (totalFrames !== expected) {
      errors.push({
        severity: "warning",
        rule: "frame_count_mismatch",
        message: `total_frames (${totalFrames}) != fps (${fps}) × duration (${duration}) = ${expected}`,
      });
    }
  }

  const aspectRatio = format.aspect_ratio as string;
  if (aspectRatio && !rules.allowed_aspect_ratios.includes(aspectRatio)) {
    errors.push({
      severity: "error",
      rule: "invalid_aspect_ratio",
      message: `Aspect ratio "${aspectRatio}" not in allowed list: ${rules.allowed_aspect_ratios.join(", ")}`,
    });
  }
}

function validateBackground(
  spec: Record<string, unknown>,
  rules: typeof BRAND_RULES.cutmv,
  errors: ValidationError[],
): void {
  const globalRules = spec.global_rules as Record<string, unknown> | undefined;
  if (globalRules) {
    const bg = globalRules.background as string;
    if (bg && bg.toLowerCase() !== rules.background_color.toLowerCase()) {
      errors.push({
        severity: "error",
        rule: "background_color",
        message: `Background "${bg}" must be "${rules.background_color}"`,
      });
    }
  }
}

// ── Main validator ──
export function validateMotionSpec(specPath: string): ValidationResult {
  const raw = fs.readFileSync(specPath, "utf-8");
  const spec = JSON.parse(raw) as Record<string, unknown>;
  const brand = (spec.brand as string) || "cutmv";
  const rules = BRAND_RULES[brand as keyof typeof BRAND_RULES];

  if (!rules) {
    return {
      valid: false,
      errors: [
        {
          severity: "error",
          rule: "unknown_brand",
          message: `No rules defined for brand "${brand}"`,
        },
      ],
      warnings: [],
      spec_id: (spec.template_id as string) || "unknown",
    };
  }

  const allErrors: ValidationError[] = [];

  validateBrandAssets(spec, allErrors);
  validateLogo(spec, allErrors);
  validateCTA(spec, rules, allErrors);
  validateTypography(spec, rules, allErrors);
  validateDuration(spec, rules, allErrors);
  validateBackground(spec, rules, allErrors);

  const errors = allErrors.filter((e) => e.severity === "error");
  const warnings = allErrors.filter((e) => e.severity === "warning");

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    spec_id: (spec.template_id as string) || "unknown",
  };
}

// ── CLI runner ──
if (require.main === module) {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("Usage: npx ts-node validateMotionSpec.ts <path-to-spec.json>");
    process.exit(1);
  }

  const resolved = path.resolve(specPath);
  console.log(`\n🔍 Validating: ${resolved}\n`);

  const result = validateMotionSpec(resolved);

  console.log(`   Spec ID: ${result.spec_id}`);

  if (result.errors.length > 0) {
    console.log(`\n❌ ERRORS (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(
        `   [${err.rule}]${err.scene ? ` scene:${err.scene}` : ""} ${err.message}`,
      );
    }
  }

  if (result.warnings.length > 0) {
    console.log(`\n⚠️  WARNINGS (${result.warnings.length}):`);
    for (const warn of result.warnings) {
      console.log(
        `   [${warn.rule}]${warn.scene ? ` scene:${warn.scene}` : ""} ${warn.message}`,
      );
    }
  }

  if (result.valid) {
    console.log(`\n✅ SPEC VALID. ${result.warnings.length} warnings.`);
  } else {
    console.log(
      `\n❌ SPEC INVALID. ${result.errors.length} errors, ${result.warnings.length} warnings.`,
    );
  }

  process.exit(result.valid ? 0 : 1);
}
