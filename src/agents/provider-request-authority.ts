import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const requestAuthority = resolveGlobalSingleton(
  Symbol.for("openclaw.providerRequestAuthority"),
  () => new AsyncLocalStorage<() => void>(),
);

/** Carries the caller's captured assertion; never resolves or grants authority by an id. */
export function withProviderRequestAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: () => T,
): T {
  return assertCurrent ? requestAuthority.run(assertCurrent, run) : run();
}

/** Capture before transport awaits so replacement cannot substitute a later owner. */
export function getProviderRequestAuthority(): (() => void) | undefined {
  return requestAuthority.getStore();
}
