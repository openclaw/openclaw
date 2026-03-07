/**
 * assetPolicy.ts — Brand-specific asset allowlists.
 *
 * Codifies the rule:
 *   - CUTMV can use both CUTMV logo + Full Digital logo
 *   - Full Digital can ONLY use Full Digital logo
 *   - UI screenshots and demo frames are brand-locked
 *
 * Usage:
 *   import { assertAllowedLogo, assertAllowedUI } from './assetPolicy';
 *   assertAllowedLogo('cutmv', 'cutmv/logo.png');          // ✅
 *   assertAllowedLogo('cutmv', 'cutmv/fd-logo-new.png');   // ✅ (CUTMV can use FD logo)
 *   assertAllowedLogo('fulldigital', 'cutmv/logo.png');    // ❌ THROWS
 */

export type Brand = "cutmv" | "fulldigital";

// ── Logo allowlists ──
// Source paths (in brand-ai repo):
//   brands/cutmv/datasets/static/brand_assets/logos/cutmv-logo-header.png
//   brands/cutmv/datasets/static/brand_assets/logos/fd logo new.png
//   brands/cutmv/datasets/static/brand_assets/logos/fd logo 2025 - white.png
//
// staticFile paths (in public/cutmv/):
//   cutmv/logo.png
//   cutmv/fd-logo-new.png
//   cutmv/fd-logo-2025-white.png

const CUTMV_ALLOWED_LOGOS = new Set([
  // CUTMV can use both its own logo AND FD logos
  "cutmv/logo.png",
  "cutmv/fd-logo-new.png",
  "cutmv/fd-logo-2025-white.png",
  // Source paths (for MotionSpec validation before copy-to-public)
  "brands/cutmv/datasets/static/brand_assets/logos/cutmv-logo-header.png",
  "brands/cutmv/datasets/static/brand_assets/logos/fd logo new.png",
  "brands/cutmv/datasets/static/brand_assets/logos/fd logo 2025 - white.png",
]);

const FD_ALLOWED_LOGOS = new Set([
  // Full Digital can ONLY use FD logos
  "cutmv/fd-logo-new.png",
  "cutmv/fd-logo-2025-white.png",
  // Source paths
  "brands/cutmv/datasets/static/brand_assets/logos/fd logo new.png",
  "brands/cutmv/datasets/static/brand_assets/logos/fd logo 2025 - white.png",
  // If FD has its own logo folder in the future:
  // "brands/fulldigital/datasets/static/brand_assets/logos/..."
]);

export function assertAllowedLogo(brand: Brand, logoPath: string): void {
  const allowed = brand === "cutmv" ? CUTMV_ALLOWED_LOGOS : FD_ALLOWED_LOGOS;
  if (!allowed.has(logoPath)) {
    throw new Error(
      `LOGO POLICY VIOLATION: brand="${brand}" cannot use logo="${logoPath}"\n` +
        `Allowed logos for ${brand}: ${[...allowed].join(", ")}`,
    );
  }
}

// ── UI screenshot allowlists ──
// CUTMV UI must come from CUTMV sources only
// Full Digital UI must come from Full Digital sources only (when created)

const CUTMV_ALLOWED_UI_PREFIXES = [
  "cutmv/ui_screenshot_",
  "cutmv/dashboard_ui",
  "brands/cutmv/datasets/static/ui/",
];

const FD_ALLOWED_UI_PREFIXES = [
  "brands/fulldigital/datasets/static/ui/",
  // Add fulldigital/ public paths when created
];

export function assertAllowedUI(brand: Brand, uiPath: string): void {
  const prefixes =
    brand === "cutmv" ? CUTMV_ALLOWED_UI_PREFIXES : FD_ALLOWED_UI_PREFIXES;
  const allowed = prefixes.some((p) => uiPath.startsWith(p));
  if (!allowed) {
    throw new Error(
      `UI ASSET POLICY VIOLATION: brand="${brand}" cannot use UI asset="${uiPath}"\n` +
        `Allowed prefixes for ${brand}: ${prefixes.join(", ")}`,
    );
  }
}

// ── Demo frame allowlists ──
const CUTMV_ALLOWED_FRAME_PREFIXES = [
  "cutmv/demo_frame_",
  "brands/cutmv/datasets/motion/frames/",
];

export function assertAllowedDemoFrame(
  brand: Brand,
  framePath: string,
): void {
  if (brand !== "cutmv") {
    throw new Error(
      `DEMO FRAME POLICY VIOLATION: brand="${brand}" cannot use demo frames (CUTMV only)`,
    );
  }
  const allowed = CUTMV_ALLOWED_FRAME_PREFIXES.some((p) =>
    framePath.startsWith(p),
  );
  if (!allowed) {
    throw new Error(
      `DEMO FRAME POLICY VIOLATION: path="${framePath}" not in allowed prefixes: ${CUTMV_ALLOWED_FRAME_PREFIXES.join(", ")}`,
    );
  }
}

// ── Full asset manifest (for reference/documentation) ──
export const ASSET_MANIFEST = {
  cutmv: {
    logos: {
      primary: "cutmv/logo.png",
      fd_logo: "cutmv/fd-logo-new.png",
      fd_logo_white: "cutmv/fd-logo-2025-white.png",
    },
    ui_screenshots: {
      screenshot_001: "cutmv/ui_screenshot_001.png",
      screenshot_002: "cutmv/ui_screenshot_002.png",
      screenshot_003: "cutmv/ui_screenshot_003.png",
      dashboard: "cutmv/dashboard_ui.jpg",
    },
    demo_frames: {
      frame_001: "cutmv/demo_frame_001.png",
      frame_002: "cutmv/demo_frame_002.png",
      frame_003: "cutmv/demo_frame_003.png",
    },
    source_folders: {
      logos:
        "brands/cutmv/datasets/static/brand_assets/logos/",
      ui_1920:
        "brands/cutmv/datasets/static/ui/screens/1920x1080/",
      ui_1440:
        "brands/cutmv/datasets/static/ui/screens/1440x900/",
      demo_frames:
        "brands/cutmv/datasets/motion/frames/cutmv - general - demo video - 1/",
    },
  },
} as const;
