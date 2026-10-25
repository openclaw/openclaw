import { probeSqlite, isSqliteWalResetSafeVersion } from "./node-sqlite-capabilities.mjs";
import { isSupportedOpenClawNodeVersion, SUPPORTED_NODE_VERSION_RANGE } from "./node-version.mjs";
import { resolveRuntimeBootstrapEntrypointUrl } from "./runtime-process-bootstrap.generated.mjs";

export { isSqliteWalResetSafeVersion };

// The launcher and bundled runtime chunks must share one process-local result.
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

function isSqliteCapabilities(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.available === "boolean" &&
    (value.version === null || typeof value.version === "string") &&
    typeof value.text === "boolean" &&
    typeof value.blob === "boolean" &&
    typeof value.json === "boolean" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

async function probeCurrentSqlite() {
  let worker;
  try {
    const DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
    if (typeof DatabaseSync !== "function") {
      return unavailableSqliteCapabilities(new Error("node:sqlite is unavailable"));
    }
    // Keep the real capability check when Node's permission policy forbids workers.
    if (!process.versions.bun && process.permission && !process.permission.has("worker")) {
      return probeSqlite(DatabaseSync);
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(NODE_OPTIONS|BUN_OPTIONS)$/i.test(name)),
    );
    env.NODE_NO_WARNINGS = "1";
    // Older diagnostic runtimes need SQLite enabled, but must not replay entry preloads.
    const execArgv =
      !process.versions.bun && process.allowedNodeEnvironmentFlags?.has("--experimental-sqlite")
        ? ["--experimental-sqlite"]
        : [];
    const { Worker } = await import("node:worker_threads");
    worker = new Worker(resolveRuntimeBootstrapEntrypointUrl("sqliteCapabilities"), {
      env,
      execArgv,
    });
  } catch (error) {
    return unavailableSqliteCapabilities(error);
  }
  return new Promise((resolve) => {
    let result;
    let failure;
    let retirement;
    const fail = (error) => {
      failure ??= { error };
      retirement ??= Promise.resolve()
        .then(() => worker.terminate())
        .catch((/** @type {unknown} */ retirementError) => {
          failure ??= { error: retirementError };
        });
    };
    const onMessage = (value) => {
      if (result !== undefined || !isSqliteCapabilities(value)) {
        fail(new Error("SQLite capability worker returned an invalid result"));
        return;
      }
      result = value;
    };
    const onExit = (code) => {
      worker.off("message", onMessage);
      worker.off("error", fail);
      worker.off("messageerror", fail);
      if (failure) {
        resolve(unavailableSqliteCapabilities(failure.error));
      } else if (code !== 0 || result === undefined) {
        resolve(
          unavailableSqliteCapabilities(
            new Error(`SQLite capability worker exited without a complete result (code ${code})`),
          ),
        );
      } else {
        // The scratch database and worker must both close before startup is admitted.
        resolve(result);
      }
    };
    worker.on("message", onMessage);
    worker.on("error", fail);
    worker.on("messageerror", fail);
    worker.once("exit", onExit);
  });
}

export function detectCurrentSqliteCapabilities() {
  // Publish the Promise before Worker construction can notify another startup caller.
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
