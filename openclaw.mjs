#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import module from "node:module";
import { fileURLToPath } from "node:url";

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

const isDirectModuleNotFoundError = (err, specifier) => {
  if (!isModuleNotFoundError(err)) {
    return false;
  }

  const expectedUrl = new URL(specifier, import.meta.url);
  if ("url" in err && err.url === expectedUrl.href) {
    return true;
  }

  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  const expectedPath = fileURLToPath(expectedUrl);
  return (
    message.includes(`Cannot find module '${expectedPath}'`) ||
    message.includes(`Cannot find module "${expectedPath}"`)
  );
};

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
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
};

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow direct entry misses; rethrow transitive resolution failures.
    if (isDirectModuleNotFoundError(err, specifier)) {
      return false;
    }
    throw err;
  }
};

const exists = async (specifier) => {
  try {
    await access(new URL(specifier, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

const buildMissingEntryErrorMessage = async () => {
  const lines = ["openclaw: missing dist/entry.(m)js (build output)."];
  if (!(await exists("./src/entry.ts"))) {
    return lines.join("\n");
  }

  lines.push("This install looks like an unbuilt source tree or GitHub source archive.");
  lines.push(
    "Build locally with `pnpm install && pnpm build`, or install a built package instead.",
  );
  lines.push(
    "For pinned GitHub installs, use `npm install -g github:openclaw/openclaw#<ref>` instead of a raw `/archive/<ref>.tar.gz` URL.",
  );
  lines.push("For releases, use `npm install -g openclaw@latest`.");
  return lines.join("\n");
};

const isBareRootHelpInvocation = (argv) =>
  argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h");

const loadPrecomputedRootHelpText = () => {
  try {
    const raw = readFileSync(new URL("./dist/cli-startup-metadata.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.rootHelpText === "string" && parsed.rootHelpText.length > 0
      ? parsed.rootHelpText
      : null;
  } catch {
    return null;
  }
};

const tryOutputBareRootHelp = async () => {
  if (!isBareRootHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedRootHelpText();
  if (precomputed) {
    process.stdout.write(precomputed);
    return true;
  }
  for (const specifier of ["./dist/cli/program/root-help.js", "./dist/cli/program/root-help.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.outputRootHelp === "function") {
        mod.outputRootHelp();
        return true;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
  return false;
};

if (await tryOutputBareRootHelp()) {
  // OK
} else {
  await installProcessWarningFilter();
  if (await tryImport("./dist/entry.js")) {
    // OK
  } else if (await tryImport("./dist/entry.mjs")) {
    // OK
  } else {
    throw new Error(await buildMissingEntryErrorMessage());
  }
}
