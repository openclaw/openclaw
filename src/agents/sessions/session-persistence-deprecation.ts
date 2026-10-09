import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Source and bundled SDK graphs share one warning budget for this process.
const warned = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPersistenceDeprecations"),
  () => new Set<string>(),
);

export function warnSessionPersistenceDeprecation(
  method: string,
  replacement: string,
  options?: { pluginId: string },
): void {
  const key = options ? JSON.stringify([options.pluginId, method]) : method;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  process.emitWarning(
    `${options ? `Plugin ${options.pluginId}: ` : ""}${method} is deprecated; await ${replacement} instead. Removal: next Plugin SDK major.`,
    { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
  );
}
