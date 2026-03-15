/** Format a Date as YYYY-MM-DD in local time. */
export function toDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Current ISO-8601 timestamp. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Simple UUID v4 (crypto.randomUUID). */
export function uuid(): string {
  return crypto.randomUUID();
}
