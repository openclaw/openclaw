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

const buildAndRetry = async () => {
  // Check if package.json exists (indicates we're in a project directory, not an installed package)
  try {
    await import("./package.json");
  } catch {
    // Not a project directory, re-throw the original error
    throw new Error("openclaw: missing dist/entry.(m)js (build output). Run 'pnpm build' to build the project.");
  }

  // We're in a project directory - try to build
  console.error("openclaw: dist/ not found, building...");
  const { spawn } = await import("node:child_process");
  
  return new Promise((resolve, reject) => {
    const build = spawn("pnpm", ["build"], { 
      stdio: "inherit",
      shell: true 
    });
    build.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`openclaw: build failed with code ${code}`));
        return;
      }
      resolve(true);
    });
  });
};

if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  // Try to build and retry
  await buildAndRetry();
  
  // Retry after build
  if (await tryImport("./dist/entry.js")) {
    // OK
  } else if (await tryImport("./dist/entry.mjs")) {
    // OK
  } else {
    throw new Error("openclaw: missing dist/entry.(m)js (build output).");
  }
}
