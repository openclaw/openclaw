import type { EasingFunction } from "./types";

/**
 * Reverse an easing function (mirror on Y axis)
 * @param easing - Original easing function
 * @returns Reversed easing function
 */
export function reverseEasing(easing: EasingFunction): EasingFunction {
  return (t: number) => 1 - easing(t);
}

/**
 * Mirror an easing function (ease in becomes ease out)
 * @param easing - Original easing function
 * @returns Mirrored easing function
 */
export function mirrorEasing(easing: EasingFunction): EasingFunction {
  return (t: number) => {
    if (t < 0.5) {
      return easing(t * 2) / 2;
    }
    return 1 - easing((1 - t) * 2) / 2;
  };
}

/**
 * Create a stepped easing function
 * @param steps - Number of steps
 * @param jumpStart - Whether to jump at the start of each step
 * @returns Stepped easing function
 */
export function steps(
  steps: number,
  jumpStart: boolean = false,
): EasingFunction {
  return (t: number) => {
    const stepSize = 1 / steps;
    const step = Math.floor(t / stepSize);
    const offset = jumpStart ? 1 : 0;
    return Math.min((step + offset) * stepSize, 1);
  };
}

/**
 * Combine two easing functions with a split point
 * @param easing1 - First easing function
 * @param easing2 - Second easing function
 * @param split - Split point (0-1, default: 0.5)
 * @returns Combined easing function
 */
export function combineEasings(
  easing1: EasingFunction,
  easing2: EasingFunction,
  split: number = 0.5,
): EasingFunction {
  return (t: number) => {
    if (t < split) {
      return easing1(t / split) * split;
    }
    return split + easing2((t - split) / (1 - split)) * (1 - split);
  };
}

/**
 * Scale an easing function to a specific range
 * @param easing - Original easing function
 * @param min - Minimum output value
 * @param max - Maximum output value
 * @returns Scaled easing function
 */
export function scaleEasing(
  easing: EasingFunction,
  min: number,
  max: number,
): EasingFunction {
  return (t: number) => {
    const easedValue = easing(t);
    return min + easedValue * (max - min);
  };
}

/**
 * Interpolate between two values using an easing function
 * @param from - Start value
 * @param to - End value
 * @param progress - Progress (0-1)
 * @param easing - Easing function
 * @returns Interpolated value
 */
export function interpolate(
  from: number,
  to: number,
  progress: number,
  easing: EasingFunction,
): number {
  const easedProgress = easing(progress);
  return from + (to - from) * easedProgress;
}
