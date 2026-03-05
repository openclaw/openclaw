import type { EasingFunction, BezierPoints } from "./types";

/**
 * Create a cubic bezier easing function
 * Based on the CSS cubic-bezier() function
 *
 * @param x1 - X coordinate of first control point (0-1)
 * @param y1 - Y coordinate of first control point
 * @param x2 - X coordinate of second control point (0-1)
 * @param y2 - Y coordinate of second control point
 * @returns Easing function
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EasingFunction {
  // Validate input
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new Error("x1 and x2 must be between 0 and 1");
  }

  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    // Binary search for the correct t value
    let mid = t;

    // Newton-Raphson iteration for better performance
    for (let i = 0; i < 8; i++) {
      const x = sampleCurveX(mid, x1, x2);
      const slope = sampleCurveDerivativeX(mid, x1, x2);

      if (Math.abs(x - t) < 0.000001) break;
      if (Math.abs(slope) < 0.000001) break;

      mid -= (x - t) / slope;
    }

    return sampleCurveY(mid, y1, y2);
  };
}

/**
 * Sample the X value of the cubic bezier curve at time t
 */
function sampleCurveX(t: number, x1: number, x2: number): number {
  return (
    (1 - t) ** 3 * 0 +
    3 * (1 - t) ** 2 * t * x1 +
    3 * (1 - t) * t ** 2 * x2 +
    t ** 3 * 1
  );
}

/**
 * Sample the Y value of the cubic bezier curve at time t
 */
function sampleCurveY(t: number, y1: number, y2: number): number {
  return (
    (1 - t) ** 3 * 0 +
    3 * (1 - t) ** 2 * t * y1 +
    3 * (1 - t) * t ** 2 * y2 +
    t ** 3 * 1
  );
}

/**
 * Sample the derivative of the X curve at time t
 */
function sampleCurveDerivativeX(t: number, x1: number, x2: number): number {
  return (
    3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t ** 2 * (1 - x2)
  );
}

/**
 * Create a bezier easing from control points object
 */
export function bezier(points: BezierPoints): EasingFunction {
  return cubicBezier(points.x1, points.y1, points.x2, points.y2);
}
