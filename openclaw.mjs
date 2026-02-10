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

// Ultra-fast path for --version: resolve version from package.json without
// loading the full CLI (avoids respawn, command registration, etc.).
const versionArgs = new Set(["--version", "-V", "-v"]);
const helpArgs = new Set(["--help", "-h"]);
const hasVersion = process.argv.some((a) => versionArgs.has(a));
const hasHelp = process.argv.some((a) => helpArgs.has(a));
if (hasVersion && !hasHelp) {
  const { createRequire } = await import("node:module");
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("./package.json");
    console.log(pkg.version);
    process.exit(0);
  } catch {
    // Fall through to full CLI if package.json unavailable
  }
}

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
