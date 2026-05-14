import type { LogMemoryEntry, LogMemoryPayloadType } from "./types.js";

// Decay model from the spec: exponential recency, diminishing access boost,
// importance multiplier from payload type. Result clamped to [0, 1].
export function computeCurrentDecay(entry: LogMemoryEntry, now: Date): number {
  if (entry.payload.pinned) {
    return 1.0;
  }
  const ageHours = (now.getTime() - entry.timestamp.getTime()) / 3_600_000;
  const recencyFactor = Math.exp(-0.05 * Math.max(0, ageHours));
  const accessBoost = Math.min(entry.payload.accessCount * 0.1, 0.5);
  const importanceMultiplier = importanceFor(entry.payload.type);
  const score = (recencyFactor + accessBoost) * importanceMultiplier;
  return Math.min(Math.max(score, 0), 1);
}

// Initial decay at write time. ERROR-level signal gets boosted so it lasts
// longer in the episodic layer before becoming a dream candidate.
export function computeInitialDecay(level: "ERROR" | "WARN" | "INFO"): number {
  const base = 1.0;
  const boosted = level === "ERROR" ? base * 1.5 : base;
  return Math.min(boosted, 1.0);
}

function importanceFor(type: LogMemoryPayloadType): number {
  switch (type) {
    case "conversation_rule":
      return 2.5;
    case "engineer_knowledge":
      return 2.0;
    case "error_pattern":
      return 1.5;
    default:
      return 1.0;
  }
}
