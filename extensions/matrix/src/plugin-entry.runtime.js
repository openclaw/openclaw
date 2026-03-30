// Thin ESM wrapper so native dynamic import() resolves in source-checkout mode
// where jiti loads index.ts but import("./src/plugin-entry.runtime.js") uses
// Node's native ESM loader which cannot resolve .ts files directly.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const PLUGIN_SDK_EXPORT_PREFIX = "./plugin-sdk/";
const PLUGIN_SDK_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];
const JITI_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mtsx",
  ".ctsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
];

function readPackageJson(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function findOpenClawPackageRoot(startDir) {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    const pkg = readPackageJson(cursor);
    if (pkg?.name === "openclaw" && pkg.exports?.["./plugin-sdk"]) {
      return { packageRoot: cursor, packageJson: pkg };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

function resolveExistingFile(basePath, extensions) {
  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildPluginSdkAliasMap(moduleUrl) {
  const location = findOpenClawPackageRoot(path.dirname(fileURLToPath(moduleUrl)));
  if (!location) {
    return {};
  }

  const { packageRoot, packageJson } = location;
  const sourcePluginSdkDir = path.join(packageRoot, "src", "plugin-sdk");
  const distPluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
  const aliasMap = {};
  const rootAlias =
    resolveExistingFile(path.join(sourcePluginSdkDir, "root-alias"), [".cjs"]) ??
    resolveExistingFile(path.join(distPluginSdkDir, "root-alias"), [".cjs"]);
  if (rootAlias) {
    aliasMap["openclaw/plugin-sdk"] = rootAlias;
  }

  for (const exportKey of Object.keys(packageJson.exports ?? {})) {
    if (!exportKey.startsWith(PLUGIN_SDK_EXPORT_PREFIX)) {
      continue;
    }
    const subpath = exportKey.slice(PLUGIN_SDK_EXPORT_PREFIX.length);
    if (!subpath) {
      continue;
    }
    const resolvedPath =
      resolveExistingFile(path.join(sourcePluginSdkDir, subpath), PLUGIN_SDK_SOURCE_EXTENSIONS) ??
      resolveExistingFile(path.join(distPluginSdkDir, subpath), [".js"]);
    if (resolvedPath) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = resolvedPath;
    }
  }

  const extensionApi =
    resolveExistingFile(path.join(packageRoot, "src", "extensionAPI"), [".ts", ".js"]) ??
    resolveExistingFile(path.join(packageRoot, "dist", "extensionAPI"), [".js"]);
  if (extensionApi) {
    aliasMap["openclaw/extension-api"] = extensionApi;
  }

  return aliasMap;
}

const jiti = createJiti(import.meta.url, {
  alias: buildPluginSdkAliasMap(import.meta.url),
  interopDefault: true,
  tryNative: false,
  extensions: JITI_EXTENSIONS,
});

const mod = jiti("./plugin-entry.runtime.ts");
export const ensureMatrixCryptoRuntime = mod.ensureMatrixCryptoRuntime;
export const handleVerifyRecoveryKey = mod.handleVerifyRecoveryKey;
export const handleVerificationBootstrap = mod.handleVerificationBootstrap;
export const handleVerificationStatus = mod.handleVerificationStatus;
