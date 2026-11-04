import { freezeJsonSnapshot } from "../../shared/immutable-data.js";

/** Host capabilities retain immutable input facts independently of caller mutation. */
export function cloneHostSnapshot<T>(value: T): T {
  return freezeJsonSnapshot(structuredClone(value));
}
