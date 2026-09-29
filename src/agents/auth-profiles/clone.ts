/**
 * Auth profile store cloning helpers.
 * Keeps store snapshots JSON-serializable before callers mutate or persist
 * profile state.
 */
import { isDeepStrictEqual } from "node:util";
import type { AuthProfileStore } from "./types.js";

/** Deep-clones an auth profile store and rejects non-JSON values. */
export function cloneAuthProfileStore<T extends AuthProfileStore>(store: T): T {
  return JSON.parse(
    JSON.stringify(store, (_key, value: unknown) => {
      if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new TypeError(`AuthProfileStore contains non-JSON value: ${typeof value}`);
      }
      return value;
    }),
  ) as T;
}

/** Compare the same JSON shape; materialization can add or drop undefined optional fields. */
export function areAuthProfileStoresEqual(
  left: AuthProfileStore,
  right: AuthProfileStore,
): boolean {
  return isDeepStrictEqual(cloneAuthProfileStore(left), cloneAuthProfileStore(right));
}
