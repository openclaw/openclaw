export type AgentTabIconShape = "square" | "rounded" | "circle";
export type TabIconPreference =
  | "default"
  | "agent"
  | "agent:rounded"
  | "agent:circle"
  | `lobster:${string}`;

/** Saved source preferences stay valid; agent artwork now has one circular crop. */
export function agentTabIconShape(value: TabIconPreference | undefined): "circle" | null {
  return value === "agent" || value === "agent:rounded" || value === "agent:circle"
    ? "circle"
    : null;
}

export function normalizeTabIconPreference(value: unknown): TabIconPreference | undefined {
  if (
    value === "default" ||
    value === "agent" ||
    value === "agent:rounded" ||
    value === "agent:circle"
  ) {
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
