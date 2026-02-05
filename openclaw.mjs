#!/usr/bin/env node

// 🦀 Claw's patch: Suppress punycode deprecation warning (DEP0040) from transitive dependencies
const originalEmit = process.emit.bind(process);
process.emit = function (event, ...args) {
  if (
    event === "warning" &&
    args[0]?.name === "DeprecationWarning" &&
    args[0]?.code === "DEP0040"
  ) {
    return false;
  }
  return originalEmit(event, ...args);
};

import module from "node:module";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

await import("./dist/entry.js");
