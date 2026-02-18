#!/usr/bin/env node

import module from "node:module";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

// Fast-path: print version and exit without loading the full CLI module graph.
// Avoids process respawn + 28MB dist import for a simple version query.
// Scans top-level flags only — stops at the first non-flag arg (subcommand).
let _versionFlag = false;
for (let _i = 2; _i < process.argv.length; _i++) {
  const _a = process.argv[_i];
  if (_a === "--version" || _a === "-v" || _a === "-V") {
    _versionFlag = true;
    break;
  }
  if (_a === "--" || !_a.startsWith("-")) {
    break;
  }
  if (_a === "--profile") {
    const _next = process.argv[_i + 1];
    if (_next && !_next.startsWith("-")) {
      _i++;
    }
  }
}
if (_versionFlag) {
  let _version = process.env.OPENCLAW_BUNDLED_VERSION;
  if (!_version) {
    try {
      const _require = module.createRequire(import.meta.url);
      _version = _require("./package.json").version;
    } catch {}
  }
  console.log(_version || "0.0.0");
  process.exit(0);
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
};

await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (isModuleNotFoundError(err)) {
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
