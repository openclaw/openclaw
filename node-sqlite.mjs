import { probeSqlite, isSqliteWalResetSafeVersion } from "./node-sqlite-capabilities.mjs";
import { isSupportedOpenClawNodeVersion, SUPPORTED_NODE_VERSION_RANGE } from "./node-version.mjs";

export { isSqliteWalResetSafeVersion };

// The launcher and bundled runtime chunks share one process-local admission result.
const capabilityCacheKey = Symbol.for("openclaw.sqliteCapabilities");
function unavailableSqliteCapabilities(error) {
  return {
    available: false,
    version: null,
    text: false,
    blob: false,
    json: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function probeCurrentSqlite() {
  try {
    const DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
    if (typeof DatabaseSync !== "function") {
      return unavailableSqliteCapabilities(new Error("node:sqlite is unavailable"));
    }
    // This fixed boot-admission probe owns only a scratch in-memory database.
    return probeSqlite(DatabaseSync);
  } catch (error) {
    return unavailableSqliteCapabilities(error);
  }
}

export function detectCurrentSqliteCapabilities() {
  // Defer the probe until the shared Promise is published; the database closes before it resolves.
  globalThis[capabilityCacheKey] ??= Promise.resolve().then(probeCurrentSqlite);
  return Promise.resolve(globalThis[capabilityCacheKey]);
}

export function nodeRuntimeFailure(version, probe) {
  const label = `Node ${version ?? "unknown"}`;
  if (!probe.available) {
    return `${label}: node:sqlite is unavailable; use 24.22.1+/26.12.1+ or a build with the fix.`;
  }
  if (!probe.text && !probe.error) {
    return `${label}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.22.1+/26.12.1+ or a build with the fix`;
  }
  if (probe.error || !probe.text || !probe.blob || !probe.json) {
    return `${label}: node:sqlite NUL round-trip capability check failed; use 24.22.1+/26.12.1+ or a build with the fix.`;
  }
  if (!probe.version || !isSqliteWalResetSafeVersion(probe.version)) {
    return `${label}: SQLite ${probe.version ?? "unknown"} is not WAL-reset-safe; use SQLite 3.51.3+, 3.50.7+, or 3.44.6+ on its patched release line.`;
  }
  // SQLite capabilities cannot establish that the TLS verifier rejects compromised keys.
  if (!isSupportedOpenClawNodeVersion(version)) {
    return `${label}: openclaw requires Node ${SUPPORTED_NODE_VERSION_RANGE.replace(" || ", ", or ")}.`;
  }
  return null;
}
