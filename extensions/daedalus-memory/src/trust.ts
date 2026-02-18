/**
 * Trust state machine — pure functions, no I/O.
 *
 * Defines trust levels, allowed transitions, and helpers
 * for the DAEDALUS memory trust lifecycle.
 */

export type TrustLevel = "blue" | "green" | "red";
export type Origin = "user" | "ai_suggested";
export type TransitionTrigger =
  | "initial_write"
  | "human_approve"
  | "human_reject"
  | "human_resolve"
  | "staleness_timeout"
  | "constraint_violation";

const ALLOWED_TRANSITIONS: Set<string> = new Set([
  "green:blue",
  "green:red",
  "blue:red",
  "red:blue",
]);

const TRIGGER_MAP: Map<string, Set<TransitionTrigger>> = new Map([
  ["green:blue", new Set<TransitionTrigger>(["human_approve"])],
  ["green:red", new Set<TransitionTrigger>(["human_reject", "staleness_timeout", "constraint_violation"])],
  ["blue:red", new Set<TransitionTrigger>(["human_reject"])],
  ["red:blue", new Set<TransitionTrigger>(["human_resolve"])],
]);

/** Returns `true` if the trust-level transition from → to is allowed. */
export function isValidTransition(from: TrustLevel, to: TrustLevel): boolean {
  return ALLOWED_TRANSITIONS.has(`${from}:${to}`);
}

/** Returns `true` if the transition is allowed AND the trigger is valid for that transition. */
export function isValidTransitionWithTrigger(
  from: TrustLevel,
  to: TrustLevel,
  trigger: TransitionTrigger,
): boolean {
  if (!isValidTransition(from, to)) return false;
  const allowed = TRIGGER_MAP.get(`${from}:${to}`);
  if (!allowed) return false;
  return allowed.has(trigger);
}

/** Throws if an AI-originated fact targets trust level 'blue'. */
export function assertAICannotWriteBlue(origin: Origin, targetTrust: TrustLevel): void {
  if (origin === "ai_suggested" && targetTrust === "blue") {
    throw new Error("INVARIANT VIOLATION: AI-originated facts cannot have trust level 'blue'");
  }
}

/** Returns the default trust level for a given origin. */
export function defaultTrustForOrigin(origin: Origin): TrustLevel {
  switch (origin) {
    case "user":
      return "blue";
    case "ai_suggested":
      return "green";
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

/** Returns `true` if the fact is older than `staleDays` days. */
export function isStaleFact(createdAt: string, staleDays: number = 7): boolean {
  return (Date.now() - Date.parse(createdAt)) / 86_400_000 > staleDays;
}

/** Returns a short tag for the trust level. */
export function trustTag(level: TrustLevel): string {
  switch (level) {
    case "blue":
      return "VERIFIED";
    case "green":
      return "SUGGESTED";
    case "red":
      return "QUARANTINED";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/** Returns a human-readable description of the trust level. */
export function trustDescription(level: TrustLevel): string {
  switch (level) {
    case "blue":
      return "Verified by human — trusted";
    case "green":
      return "AI-suggested — pending human review";
    case "red":
      return "Quarantined — excluded from search results";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}
