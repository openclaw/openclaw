import crypto from "node:crypto";

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export function hashHex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function seededUnitInterval(seed: string, index = 0): number {
  const hash = hashHex(`${seed}:${index}`);
  const slice = hash.slice(0, 13);
  const numeric = Number.parseInt(slice, 16);
  const max = 0x1fffffffffffff;
  return clamp01(numeric / max);
}

export function pickFromSeed<T>(items: readonly T[], seed: string, index = 0): T {
  const rolled = seededUnitInterval(seed, index);
  const position = Math.min(items.length - 1, Math.floor(rolled * items.length));
  return items[position] as T;
}
