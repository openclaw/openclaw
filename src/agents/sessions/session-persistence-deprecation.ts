import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Source and bundled SDK graphs share one warning budget for this process.
const warned = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPersistenceDeprecations"),
  () => new Set<string>(),
);

export function warnSessionPersistenceDeprecation(method: string, replacement: string): void {
  if (warned.has(method)) {
    return;
  }
  warned.add(method);
  process.emitWarning(
    `${method} is deprecated; await ${replacement} instead. Removal: next Plugin SDK major.`,
    { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
  );
}
