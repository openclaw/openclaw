import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserRequest } from "./routes/types.js";

type BrowserRequestScope = {
  managedOnly: true;
  assertCurrent: NonNullable<BrowserRequest["assertCurrent"]>;
};
const requestScope = new AsyncLocalStorage<BrowserRequestScope>();

/** Carry a dashboard's authority through the existing local Browser client transport. */
export function withBrowserRequestScope<T>(
  scope: BrowserRequestScope,
  run: () => Promise<T>,
): Promise<T> {
  return requestScope.run(scope, run);
}

export function getBrowserRequestScope(): BrowserRequestScope | undefined {
  return requestScope.getStore();
}
