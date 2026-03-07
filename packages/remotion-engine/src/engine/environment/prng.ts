/**
 * Deterministic seeded PRNG (mulberry32).
 * Produces stable procedural layouts per spec/seed.
 */
export function createPRNG(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in [min, max) */
export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Random int in [min, max] inclusive */
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(randRange(rng, min, max + 1));
}

/** Pick random element from array */
export function randPick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
