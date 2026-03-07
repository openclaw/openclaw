/**
 * easings.ts — Shared easing functions + clamp utility.
 * Replaces duplicated clamp/ease scattered across scene renderers.
 */
import { EasingName } from "../parser/MotionSpecTypes";

export const clamp = (n: number, a: number, b: number): number =>
  Math.max(a, Math.min(b, n));

export const linear = (t: number): number => t;

export const easeInCubic = (t: number): number => t * t * t;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeInOutQuint = (t: number): number =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const easeInBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
};

const EASING_MAP: Record<EasingName, (t: number) => number> = {
  linear,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInOutQuint,
  easeOutBack,
  easeInBack,
};

export function resolveEasing(name?: EasingName): (t: number) => number {
  if (!name) return easeInOutCubic;
  return EASING_MAP[name] ?? easeInOutCubic;
}
