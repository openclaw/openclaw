/** Rotate positions and direction so a candidate does not always occupy the middle slot. */
export function controlUiBenchOrder<T>(entries: readonly T[], pair: number): T[] {
  const offset = pair % entries.length;
  const rotated = [...entries.slice(offset), ...entries.slice(0, offset)];
  return Math.floor(pair / entries.length) % 2 ? rotated.toReversed() : rotated;
}
