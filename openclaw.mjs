#!/usr/bin/env node

import fs from "node:fs/promises";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fast path for --version/-V: exit before loading heavy modules (~100x faster)
// Only trigger for root invocations, not subcommands (mirrors src/cli/argv.ts)
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);

function isRootVersionInvocation(argv) {
  const args = argv.slice(2);
  let hasVersion = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (VERSION_FLAGS.has(arg)) {
      hasVersion = true;
      continue;
    }
    if (ROOT_BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (arg.startsWith("--profile=") || arg.startsWith("--log-level=")) {
      continue;
    }
    if (ROOT_VALUE_FLAGS.has(arg)) {
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        i++;
      }
      continue;
    }
    return false; // Unknown flag or subcommand
  }
  return hasVersion;
}

if (isRootVersionInvocation(process.argv)) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, "package.json"), "utf-8"));
    console.log(pkg.version);
  } catch {
    console.log("unknown");
  }
  process.exit(0);
}

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
