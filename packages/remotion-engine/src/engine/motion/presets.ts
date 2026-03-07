/**
 * presets.ts — Built-in transition + element motion presets.
 * Spec-level overrides take priority, then these defaults.
 */
import {
  EnhancedTransitionSpec,
  ElementMotionStep,
  TransitionPresetMap,
  ElementMotionPresetMap,
} from "../parser/MotionSpecTypes";

// ── Built-in transition presets ──
export const BUILTIN_TRANSITION_PRESETS: Record<
  string,
  Omit<EnhancedTransitionSpec, "duration">
> = {
  WIPE_PREMIUM: {
    type: "wipe",
    coverage: "full",
    direction: "leftToRight",
    overscanPx: 160,
    featherPx: 44,
    easing: "easeInOutCubic",
    addGlowEdge: true,
    edgeGlowOpacity: 0.22,
  },
  SWEEP_DIAGONAL: {
    type: "sweep",
    coverage: "full",
    direction: "diagUp",
    overscanPx: 180,
    featherPx: 52,
    easing: "easeInOutQuint",
    addShadow: true,
    shadowOpacity: 0.28,
  },
  // ── Cinematic dip fade (replaces old GLITCH_REVEAL) ──
  DIP_CINEMATIC: {
    type: "dipFade",
    coverage: "full",
    easing: "easeInOutCubic",
    dipColor: "#060608",
    out: { opacityTo: 0, blurToPx: 4, scaleTo: 1.005 },
    mid: { holdFrames: 2, dipOpacity: 0.92 },
    in: { opacityFrom: 0, blurFromPx: 4, scaleFrom: 1.005 },
    antiBanding: { grainOpacity: 0.06, dither: true },
  },
  // ── Dark dip: no blur, just darken → return. Cleaner than DIP_CINEMATIC. ──
  DIP_DARK: {
    type: "dipFade",
    coverage: "full",
    easing: "easeInOutCubic",
    dipColor: "#080810",
    out: { opacityTo: 0.05, blurToPx: 0, scaleTo: 1.0 },
    mid: { holdFrames: 3, dipOpacity: 0.88 },
    in: { opacityFrom: 0.05, blurFromPx: 0, scaleFrom: 1.0 },
    antiBanding: { grainOpacity: 0.04, dither: false },
  },
  // ── Clean crossfade dissolve ──
  DISSOLVE_CLEAN: {
    type: "crossfade",
    coverage: "full",
    easing: "easeInOutCubic",
    out: { opacityTo: 0, blurToPx: 3 },
    in: { opacityFrom: 0, blurFromPx: 3 },
    antiBanding: { grainOpacity: 0.06, dither: true },
  },
  // ── Legacy GLITCH_REVEAL → now routes to clean dipFade (kept for backward compat) ──
  GLITCH_REVEAL: {
    type: "dipFade",
    coverage: "full",
    easing: "easeInOutCubic",
    dipColor: "#060608",
    out: { opacityTo: 0, blurToPx: 4, scaleTo: 1.005 },
    mid: { holdFrames: 2, dipOpacity: 0.92 },
    in: { opacityFrom: 0, blurFromPx: 4, scaleFrom: 1.005 },
    antiBanding: { grainOpacity: 0.06, dither: true },
  },
};

// ── Built-in element motion presets ──
export const BUILTIN_ELEMENT_PRESETS: Record<
  string,
  Omit<ElementMotionStep, "at">
> = {
  HEADLINE_IN: {
    type: "slideUpFade",
    distancePx: 30,
    durationFrames: 10,
    easing: "easeOutCubic",
  },
  HEADLINE_OUT: {
    type: "slideDownFade",
    distancePx: 18,
    durationFrames: 8,
    easing: "easeInCubic",
  },
  SUBHEAD_IN: {
    type: "fadeIn",
    durationFrames: 8,
    easing: "easeOutCubic",
  },
  SUBHEAD_OUT: {
    type: "fadeOut",
    durationFrames: 6,
    easing: "easeInCubic",
  },
  UI_IN: {
    type: "scaleIn",
    scaleFrom: 0.96,
    durationFrames: 12,
    easing: "easeOutCubic",
    shadowPop: true,
  },
  UI_OUT: {
    type: "scaleOut",
    scaleFrom: 0.985,
    durationFrames: 10,
    easing: "easeInCubic",
    blur: 2,
  },
  CTA_IN: {
    type: "popIn",
    durationFrames: 10,
    easing: "easeOutBack",
    scaleFrom: 0.94,
  },
  CTA_OUT: {
    type: "fadeOut",
    durationFrames: 6,
    easing: "easeInCubic",
  },
  ACCENT_UNDERLINE_IN: {
    type: "revealLR",
    durationFrames: 10,
    easing: "easeOutCubic",
  },
  ACCENT_UNDERLINE_OUT: {
    type: "revealRL",
    durationFrames: 8,
    easing: "easeInCubic",
  },
  BADGE_IN: {
    type: "fadeSlide",
    distancePx: 12,
    durationFrames: 8,
    easing: "easeOutCubic",
  },
  BADGE_OUT: {
    type: "fadeOut",
    durationFrames: 6,
    easing: "easeInCubic",
  },
  ICON_IN: {
    type: "popIn",
    durationFrames: 9,
    easing: "easeOutBack",
    scaleFrom: 0.85,
  },
  ICON_OUT: {
    type: "fadeOut",
    durationFrames: 6,
    easing: "easeInCubic",
  },
  LIST_ITEM_IN: {
    type: "slideUpFade",
    distancePx: 20,
    durationFrames: 10,
    easing: "easeOutCubic",
  },
  LIST_ITEM_OUT: {
    type: "fadeOut",
    durationFrames: 6,
    easing: "easeInCubic",
  },
  GRID_ITEM_IN: {
    type: "scaleIn",
    scaleFrom: 0.9,
    durationFrames: 12,
    easing: "easeOutCubic",
  },
  GRID_ITEM_OUT: {
    type: "fadeOut",
    durationFrames: 8,
    easing: "easeInCubic",
  },
};

/**
 * Resolve a transition preset by name — spec-level overrides first, then built-in.
 */
export function resolveTransitionPreset(
  presetName: string,
  specPresets?: TransitionPresetMap,
): Omit<EnhancedTransitionSpec, "duration"> | undefined {
  if (specPresets && specPresets[presetName]) return specPresets[presetName];
  return BUILTIN_TRANSITION_PRESETS[presetName];
}

/**
 * Resolve an element motion preset by name — spec-level overrides first, then built-in.
 */
export function resolveElementPreset(
  presetName: string,
  specPresets?: ElementMotionPresetMap,
): Omit<ElementMotionStep, "at"> | undefined {
  if (specPresets && specPresets[presetName]) return specPresets[presetName];
  return BUILTIN_ELEMENT_PRESETS[presetName];
}
