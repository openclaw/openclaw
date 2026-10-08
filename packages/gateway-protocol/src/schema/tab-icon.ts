export type TabIconPreference = "default" | "agent";

export function normalizeTabIconPreference(value: unknown): TabIconPreference | undefined {
  return value === "default" || value === "agent" ? value : undefined;
}
