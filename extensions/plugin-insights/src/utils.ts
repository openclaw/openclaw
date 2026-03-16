/** Compute a SQLite-compatible datetime string for N days ago */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Round a number to the given decimal places (default 1) */
export function round(n: number, decimals: number = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
