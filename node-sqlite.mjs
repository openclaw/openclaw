import { isSupportedOpenClawNodeVersion, parseNodeReleaseVersion } from "./node-version.mjs";

// Self-contained so a different runtime can execute exactly the same probe with -e.
function probeSqlite(DatabaseSync) {
  const result = { available: false, version: null, text: false, blob: false, json: false };
  let database;
  try {
    database = new DatabaseSync(":memory:");
    result.available = true;
    const version = database.prepare("SELECT sqlite_version() AS version").get()?.version;
    result.version = typeof version === "string" ? version : null;
    const text = "a\u0000b\u0000";
    const bytes = Buffer.from(text, "utf8");
    const json = JSON.stringify({ value: text });
    database.exec("CREATE TABLE probe (text_value TEXT, blob_value BLOB, json_value TEXT)");
    database.prepare("INSERT INTO probe VALUES (?, ?, ?)").run(text, bytes, json);
    const row = database.prepare("SELECT text_value, blob_value, json_value FROM probe").get();
    result.text =
      typeof row?.text_value === "string" &&
      row.text_value.length === text.length &&
      Buffer.from(row.text_value, "utf8").equals(bytes);
    result.blob =
      row?.blob_value instanceof Uint8Array && Buffer.from(row.blob_value).equals(bytes);
    result.json = row?.json_value === json && JSON.parse(row.json_value).value === text;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    database?.close();
  }
  return result;
}

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

async function probeCurrentSqliteInWorker() {
  let worker;
  try {
    if (typeof process.getBuiltinModule?.("node:sqlite")?.DatabaseSync !== "function") {
      return unavailableSqliteCapabilities(new Error("node:sqlite is unavailable"));
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
    worker = new Worker(
      `const { parentPort } = require("node:worker_threads");
       parentPort.postMessage(${SQLITE_CAPABILITY_PROBE});
       parentPort.close();`,
      { eval: true, env, execArgv },
    );
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
        .catch((error) => {
          failure ??= { error };
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
  globalThis[capabilityCacheKey] ??= Promise.resolve().then(probeCurrentSqliteInWorker);
  return Promise.resolve(globalThis[capabilityCacheKey]);
}

export function isSqliteWalResetSafeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim());
  if (!match) {
    return false;
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return false;
  }
  return (
    major > 3 ||
    (major === 3 &&
      (minor > 51 ||
        (minor === 51 && patch >= 3) ||
        (minor === 50 && patch >= 7) ||
        (minor === 44 && patch >= 6)))
  );
}

export function nodeRuntimeFailure(version, probe) {
  const label = `Node ${version ?? "unknown"}`;
  if (!probe.available) {
    return `${label}: node:sqlite is unavailable; use 24.16+/26.1+ or a build with the fix.`;
  }
  if (!probe.text && !probe.error) {
    return `${label}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.16+/26.1+ or a build with the fix`;
  }
  if (probe.error || !probe.text || !probe.blob || !probe.json) {
    return `${label}: node:sqlite NUL round-trip capability probe failed; use 24.16+/26.1+ or a build with the fix.`;
  }
  if (!probe.version || !isSqliteWalResetSafeVersion(probe.version)) {
    return `${label}: SQLite ${probe.version ?? "unknown"} is not WAL-reset-safe; use SQLite 3.51.3+, 3.50.7+, or 3.44.6+ on its patched release line.`;
  }
  // Node 22/23 remain excluded until their separate compatibility work is complete.
  const release = parseNodeReleaseVersion(version);
  if (!release || release.major < 24) {
    return `${label}: openclaw requires Node >=24.16.0 <25, or >=26.1.0.`;
  }
  return null;
}

export function nodeRuntimeNote(version, probe) {
  return !nodeRuntimeFailure(version, probe) && !isSupportedOpenClawNodeVersion(version)
    ? `Node ${version}: unsupported version, capability probe passed. Supported releases: 24.16+/26.1+.`
    : null;
}

export const SQLITE_CAPABILITY_PROBE = `(${probeSqlite.toString()})(require("node:sqlite").DatabaseSync)`;
