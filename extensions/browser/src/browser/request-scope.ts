import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserRequest } from "./routes/types.js";

type BrowserRequestScope = {
  managedOnly?: true;
  /** Host-prepared local execution parity, never read from tool arguments. */
  allowLocalLoopback?: boolean;
  assertLocalLoopbackCurrent?: () => void;
  assertInvocationCurrent?: () => void;
  assertCurrent?: NonNullable<BrowserRequest["assertCurrent"]>;
};
const requestScope = new AsyncLocalStorage<{ scope: BrowserRequestScope; active: boolean }>();

/** Carry host-prepared policy through the in-process Browser transport. */
export async function withBrowserRequestScope<T>(
  scope: BrowserRequestScope,
  run: () => Promise<T>,
): Promise<T> {
  const entry = { scope, active: true };
  if (scope.assertInvocationCurrent) {
    const assertCurrent = scope.assertInvocationCurrent;
    entry.scope = {
      ...scope,
      assertInvocationCurrent: () => {
        if (!entry.active) {
          throw new Error("Browser request has completed");
        }
        assertCurrent();
      },
    };
  }
  try {
    return await requestScope.run(entry, run);
  } finally {
    // Detached callbacks can inherit ALS but cannot retain a completed request's grant.
    entry.active = false;
  }
}

export function getBrowserRequestScope(): BrowserRequestScope | undefined {
  const entry = requestScope.getStore();
  return entry?.active ? entry.scope : undefined;
}
