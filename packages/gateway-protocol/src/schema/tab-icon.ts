export type AgentTabIconShape = "square" | "rounded" | "circle";
export type TabIconPreference =
  | "default"
  | "agent"
  | "agent:rounded"
  | "agent:circle"
  | `lobster:${string}`;

export function agentTabIconShape(value: TabIconPreference | undefined): AgentTabIconShape | null {
  if (value === "agent") {
    return "square";
  }
  if (value === "agent:rounded") {
    return "rounded";
  }
  if (value === "agent:circle") {
    return "circle";
  }
  return null;
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
