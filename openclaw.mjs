#!/usr/bin/env node

import module from "node:module";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
};

const isSupportedNodeVersion = (version) =>
  version.major > MIN_NODE_MAJOR ||
  (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR);

const ensureSupportedNodeVersion = () => {
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `openclaw: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${MIN_NODE_MAJOR}\n` +
      `  nvm use ${MIN_NODE_MAJOR}\n` +
      `  nvm alias default ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
};

ensureSupportedNodeVersion();

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

// Fast-path: print version and exit without loading the dist bundle.
// Matches the semantics of configureProgramHelp() in src/cli/program/help.ts
// which uses hasFlag() (respects -- terminator) for --version/-V and
// hasRootVersionAlias() for -v. We only handle --version/-V here; the -v
// alias needs the full CLI parser for positional-aware logic.
{
  const VERSION_FLAGS = new Set(["--version", "-V"]);
  const args = process.argv.slice(2);
  let wantsVersion = false;
  for (const arg of args) {
    if (arg === "--") {
      break;
    }
    if (VERSION_FLAGS.has(arg)) {
      wantsVersion = true;
      break;
    }
  }
  if (wantsVersion) {
    // Mirror resolveBinaryVersion() in src/version.ts:
    //   1. package.json (name === "openclaw") → 2. build-info.json → 3. env var
    const require = module.createRequire(import.meta.url);
    const PACKAGE_JSON_CANDIDATES = [
      "../package.json",
      "../../package.json",
      "../../../package.json",
      "./package.json",
    ];
    const BUILD_INFO_CANDIDATES = [
      "../build-info.json",
      "../../build-info.json",
      "./build-info.json",
    ];

    const readVersion = (candidates, { requirePackageName = false } = {}) => {
      for (const candidate of candidates) {
        try {
          const pkg = require(candidate);
          const v = pkg.version?.trim?.();
          if (!v) {
            continue;
          }
          if (requirePackageName && pkg.name !== "openclaw") {
            continue;
          }
          return v;
        } catch {
          // candidate missing or unreadable
        }
      }
      return undefined;
    };

    const version =
      readVersion(PACKAGE_JSON_CANDIDATES, { requirePackageName: true }) ||
      readVersion(BUILD_INFO_CANDIDATES) ||
      process.env.OPENCLAW_BUNDLED_VERSION;

    if (version) {
      process.stdout.write(`${version}\n`);
      process.exit(0);
    }
    // No source available — fall through to full CLI which also has
    // the compile-time __OPENCLAW_VERSION__ define.
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
