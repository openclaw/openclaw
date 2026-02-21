#!/usr/bin/env node

// Fast-path: handle --version/-V and --help/-h/no-args without loading the
// full dependency tree. On Windows+NTFS, resolving ~400 packages takes ~4s.
// This short-circuits to ~80ms by avoiding all heavy imports.
{
  const args = process.argv.slice(2);
  const hasFlag = (f) => args.includes(f);
  const isVersionRequest = hasFlag("--version") || hasFlag("-V") || hasFlag("-v");
  const isHelpRequest = hasFlag("--help") || hasFlag("-h") || args.length === 0;
  // Collect subcommand tokens (non-flag args) for cache key
  const subcommands = args.filter((a) => a[0] !== "-").map((a) => a.replace(/[/\\]/g, "_"));

  if (isVersionRequest || isHelpRequest) {
    const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const { homedir } = await import("node:os");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

    if (isVersionRequest) {
      console.log(pkg.version);
      process.exit(0);
    }

    // For help: use a cached help file keyed by version + subcommand path.
    // Cache is generated on first run and reused until version changes.
    // Examples: help-2026.2.9.txt, help-2026.2.9-gateway.txt
    const cacheDir = join(homedir(), ".openclaw", ".cache");
    const suffix = subcommands.length > 0 ? `-${subcommands.join("-")}` : "";
    const noColor = !process.stdout.isTTY || process.env.NO_COLOR !== undefined;
    const colorSuffix = noColor ? "-nocolor" : "";
    const cacheFile = join(cacheDir, `help-${pkg.version}${suffix}${colorSuffix}.txt`);

    if (existsSync(cacheFile)) {
      process.stdout.write(readFileSync(cacheFile, "utf8"));
      process.exit(0);
    }
    // Cache miss — fall through to normal load, which will generate + cache it.
    // We hook into stdout to capture the help output for caching.
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk === "string") {
        captured += chunk;
      } else {
        captured += chunk.toString();
      }
      return originalWrite(chunk, ...rest);
    };
    process.on("exit", (code) => {
      if (code === 0 && captured.length > 100) {
        try {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(cacheFile, captured);
        } catch {}
      }
    });
  }
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
