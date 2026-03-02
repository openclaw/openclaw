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

const tryImportDist = async () => {
  if (await tryImport("./dist/entry.js")) {
    return true;
  }
  if (await tryImport("./dist/entry.mjs")) {
    return true;
  }
  return false;
};

// Check if running from source (no dist/ but src/ exists) and auto-build
const isSourceBuild = async () => {
  try {
    const fs = await import("node:fs/promises");
    const distExists = await fs
      .access("./dist")
      .then(() => true)
      .catch(() => false);
    const srcExists = await fs
      .access("./src")
      .then(() => true)
      .catch(() => false);
    return !distExists && srcExists;
  } catch {
    return false;
  }
};

if (!(await tryImportDist())) {
  if (await isSourceBuild()) {
    console.error("openclaw: dist/ not found, building from source...");
    const { spawn } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      const proc = spawn("pnpm", ["build"], {
        stdio: "inherit",
        shell: true,
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(undefined);
        } else {
          reject(new Error(`build failed with code ${code}`));
        }
      });
    });
    if (!(await tryImportDist())) {
      throw new Error("openclaw: build succeeded but dist/entry.(m)js still missing.");
    }
  } else {
    throw new Error(
      "openclaw: missing dist/entry.(m)js (build output). Run 'pnpm build' or use 'npx openclaw'.",
    );
  }
}
