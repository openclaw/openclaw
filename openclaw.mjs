#!/usr/bin/env node

const warningFilterKey = Symbol.for("openclaw.warning-filter");
if (!globalThis[warningFilterKey]?.installed) {
  globalThis[warningFilterKey] = { installed: true };
  // Remove Node.js default warning handler to prevent it from printing before we filter
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return;
    if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return;
    if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite")) return;
    process.stderr.write(`${warning.stack ?? warning.toString()}\n`);
  });
}

import module from "node:module";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
      return false;
    }
    throw err;
  }
};

if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("openclaw: missing dist/entry.(m)js (build output).");
}
