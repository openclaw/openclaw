export type TabIconPreference = "default" | "agent" | `lobster:${string}`;

export function normalizeTabIconPreference(value: unknown): TabIconPreference | undefined {
  if (value === "default" || value === "agent") {
    return value;
  }
  // The browser owns the catalog and local unlocks; the profile stores only a
  // bounded identifier, never SVG, image bytes, or an arbitrary URL.
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^lobster:[a-z][a-z0-9-]{0,47}$/.test(value)
  ) {
    return undefined;
  }
  return `lobster:${value.slice("lobster:".length)}`;
}
