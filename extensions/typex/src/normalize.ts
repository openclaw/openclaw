export function normalizeTypeXTarget(raw: string): string {
  let normalized = raw.replace(/^typex:/i, "").trim();
  normalized = normalized.replace(/^(group|chat|user|dm):/i, "").trim();
  return normalized;
}
