export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}
