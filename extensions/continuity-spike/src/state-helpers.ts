import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ActivityPolicy, Direction, StepCount } from "./types.js";

// Saturation refuses new work; replay identities are never evicted to make room.
export const MAX_DECISIONS = 32;
export const MAX_TURNS = 64;
export const MAX_OPERATIONS = 96;
const MAX_AGGREGATE_BYTES = 196_608;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export function hasForbiddenControlCharacters(value: string, includeDelete = true): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point < 32 || (includeDelete && point === 127)) {
      return true;
    }
  }
  return false;
}

export class ContinuityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ContinuityError";
  }
}

export function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new ContinuityError(code);
  }
}

export function requireId(value: string): void {
  requireCondition(typeof value === "string" && ID.test(value), "invalid-identifier");
}

export function requireDirection(value: Direction): void {
  requireCondition(value === "A" || value === "B", "invalid-direction");
}

export function requireStep(value: number): asserts value is StepCount {
  requireCondition(value === 1 || value === 2 || value === 3, "invalid-step");
}

export function requireRevision(value: number): void {
  requireCondition(Number.isSafeInteger(value) && value > 0, "invalid-revision");
}

export function requireSession(value: string): void {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !hasForbiddenControlCharacters(value),
    "invalid-session-key",
  );
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function defaultPolicy(): ActivityPolicy {
  return { execute: true, statusRead: true, cancel: true };
}

export function updatePolicy(
  policy: ActivityPolicy,
  patch: Partial<ActivityPolicy>,
): ActivityPolicy {
  const keys = Object.keys(patch);
  requireCondition(
    keys.length > 0 &&
      keys.every((key) => key === "execute" || key === "statusRead" || key === "cancel"),
    "invalid-policy",
  );
  requireCondition(
    Object.values(patch).every((value) => typeof value === "boolean"),
    "invalid-policy",
  );
  return { ...policy, ...patch };
}

/** One aggregate is one native store transaction; no callback awaits or nested store access. */
export class AggregateStore<T extends { id: string }> {
  private readonly update: NonNullable<PluginStateSyncKeyedStore<T>["update"]>;

  constructor(protected readonly store: PluginStateSyncKeyedStore<T>) {
    requireCondition(store.update, "transactional-store-update-required");
    this.update = store.update.bind(store);
  }

  protected mutate<R>(id: string, change: (current: T | undefined) => { state: T; result: R }): R {
    requireId(id);
    const completion: { outcome?: { value: R } | { error: unknown } } = {};
    const written = this.update(id, (current) => {
      try {
        const next = change(current === undefined ? undefined : copy(current));
        requireCondition(next.state.id === id, "aggregate-identity-mismatch");
        requireCondition(
          Buffer.byteLength(JSON.stringify(next.state), "utf8") <= MAX_AGGREGATE_BYTES,
          "aggregate-capacity-exhausted",
        );
        completion.outcome = { value: copy(next.result) };
        return next.state;
      } catch (error) {
        // Returning undefined is the public no-write contract. Preserve domain errors
        // rather than asking SQLite's error wrapper to transport them.
        completion.outcome = { error };
        return undefined;
      }
    });
    const outcome = completion.outcome;
    if (outcome && "error" in outcome) {
      throw outcome.error;
    }
    requireCondition(written && outcome && "value" in outcome, "state-write-not-committed");
    return outcome.value;
  }
}
