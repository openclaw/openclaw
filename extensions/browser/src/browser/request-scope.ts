import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserRequest } from "./routes/types.js";
import type { BrowserSessionScope } from "./session-scope.js";

type BrowserRequestScope = {
  managedOnly?: true;
  session?: BrowserSessionScope;
  retainSession?: () => { signal: AbortSignal; assertCurrent: () => void; release: () => void };
  retainCreation?: (cleanup: () => Promise<void>) => void;
  assertCurrent: NonNullable<BrowserRequest["assertCurrent"]>;
};
const requestScope = new AsyncLocalStorage<BrowserRequestScope>();

/** Carry a dashboard's authority through the existing local Browser client transport. */
export function withBrowserRequestScope<T>(
  scope: BrowserRequestScope,
  run: () => Promise<T>,
): Promise<T> {
  return requestScope.run({ ...scope }, run);
}

/** Newly allocated targets retain their captured cleanup even after the creating request ends. */
export function withoutBrowserRequestScope<T>(run: () => Promise<T>): Promise<T> {
  return requestScope.exit(run);
}

export function getBrowserRequestScope(): BrowserRequestScope | undefined {
  return requestScope.getStore();
}
