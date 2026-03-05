import { cubicBezier } from "./cubic-bezier";
import type { EasingFunction } from "./types";

/**
 * Linear easing (no easing)
 */
export const linear: EasingFunction = (t: number) => t;

/**
 * Standard CSS easing presets
 */

// Ease
export const ease = cubicBezier(0.25, 0.1, 0.25, 1);

// Ease In
export const easeIn = cubicBezier(0.42, 0, 1, 1);
export const easeInSine = cubicBezier(0.12, 0, 0.39, 0);
export const easeInQuad = cubicBezier(0.11, 0, 0.5, 0);
export const easeInCubic = cubicBezier(0.32, 0, 0.67, 0);
export const easeInQuart = cubicBezier(0.5, 0, 0.75, 0);
export const easeInQuint = cubicBezier(0.64, 0, 0.78, 0);
export const easeInExpo = cubicBezier(0.7, 0, 0.84, 0);
export const easeInCirc = cubicBezier(0.55, 0, 1, 0.45);
export const easeInBack = cubicBezier(0.36, 0, 0.66, -0.56);

// Ease Out
export const easeOut = cubicBezier(0, 0, 0.58, 1);
export const easeOutSine = cubicBezier(0.61, 1, 0.88, 1);
export const easeOutQuad = cubicBezier(0.5, 1, 0.89, 1);
export const easeOutCubic = cubicBezier(0.33, 1, 0.68, 1);
export const easeOutQuart = cubicBezier(0.25, 1, 0.5, 1);
export const easeOutQuint = cubicBezier(0.22, 1, 0.36, 1);
export const easeOutExpo = cubicBezier(0.16, 1, 0.3, 1);
export const easeOutCirc = cubicBezier(0, 0.55, 0.45, 1);
export const easeOutBack = cubicBezier(0.34, 1.56, 0.64, 1);

// Ease In Out
export const easeInOut = cubicBezier(0.42, 0, 0.58, 1);
export const easeInOutSine = cubicBezier(0.37, 0, 0.63, 1);
export const easeInOutQuad = cubicBezier(0.45, 0, 0.55, 1);
export const easeInOutCubic = cubicBezier(0.65, 0, 0.35, 1);
export const easeInOutQuart = cubicBezier(0.76, 0, 0.24, 1);
export const easeInOutQuint = cubicBezier(0.83, 0, 0.17, 1);
export const easeInOutExpo = cubicBezier(0.87, 0, 0.13, 1);
export const easeInOutCirc = cubicBezier(0.85, 0, 0.15, 1);
export const easeInOutBack = cubicBezier(0.68, -0.6, 0.32, 1.6);

/**
 * Custom presets
 */

// Smooth and natural
export const smooth = cubicBezier(0.4, 0, 0.2, 1);
export const swift = cubicBezier(0.4, 0, 0.6, 1);

// Energetic
export const bounce = cubicBezier(0.68, -0.55, 0.265, 1.55);
export const elastic = cubicBezier(0.5, -0.5, 0.5, 1.5);

// Anticipate (overshoot at start)
export const anticipate = cubicBezier(0.36, 0, 0.66, -0.56);

// Overshoot (overshoot at end)
export const overshoot = cubicBezier(0.34, 1.56, 0.64, 1);

/**
 * Collection of all easing presets
 */
export const easings = {
  linear,
  ease,
  easeIn,
  easeInSine,
  easeInQuad,
  easeInCubic,
  easeInQuart,
  easeInQuint,
  easeInExpo,
  easeInCirc,
  easeInBack,
  easeOut,
  easeOutSine,
  easeOutQuad,
  easeOutCubic,
  easeOutQuart,
  easeOutQuint,
  easeOutExpo,
  easeOutCirc,
  easeOutBack,
  easeInOut,
  easeInOutSine,
  easeInOutQuad,
  easeInOutCubic,
  easeInOutQuart,
  easeInOutQuint,
  easeInOutExpo,
  easeInOutCirc,
  easeInOutBack,
  smooth,
  swift,
  bounce,
  elastic,
  anticipate,
  overshoot,
} as const;

export type EasingPresetName = keyof typeof easings;
