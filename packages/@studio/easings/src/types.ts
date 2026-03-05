/**
 * Easing function type
 * Takes a value between 0 and 1, returns a value between 0 and 1
 */
export type EasingFunction = (t: number) => number;

/**
 * Cubic bezier control points
 */
export interface BezierPoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
