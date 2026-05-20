export type EventPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

const RANK: Record<EventPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

export function resolveEventPriority(
  eventType: string,
  payload: Record<string, unknown>,
): EventPriority {
  const explicit = payload._priority ?? payload.priority;
  if (typeof explicit === "string" && explicit in RANK) {
    return explicit as EventPriority;
  }
  if (eventType.includes("alarm") || eventType.includes("emergency")) {
    return "CRITICAL";
  }
  if (eventType.includes("workorder") || eventType.endsWith(".created")) {
    return "HIGH";
  }
  return "NORMAL";
}

export function compareEventPriority(a: EventPriority, b: EventPriority): number {
  return RANK[a] - RANK[b];
}
