// Shared host SDK aliases for checkout staging and installed bundled plugins.
import fs from "node:fs";
import path from "node:path";
import { removePathIfExists } from "../runtime-postbuild-shared.mjs";
import { assertRealOutputRoot } from "./output-root-guard.mjs";
import { isRecord } from "./record-shared.mjs";

function writeJsonFile(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK = [
  "codex-mcp-projection.js",
  "codex-session-transcript-runtime.js",
  "qa-channel.js",
  "qa-channel-protocol.js",
  "qa-lab.js",
  "qa-runtime.js",
  "ssrf-runtime-internal.js",
];

function tryReadJsonFile(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isSafePluginSdkSubpathSegment(subpath) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function readPrivateLocalOnlyPluginSdkDistFileNames(repoRoot) {
  const privateFileNames = new Set(PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK);
  const subpaths = tryReadJsonFile(
    path.join(repoRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  if (!Array.isArray(subpaths)) {
    return privateFileNames;
  }
  for (const subpath of subpaths) {
    if (typeof subpath === "string" && isSafePluginSdkSubpathSegment(subpath)) {
      privateFileNames.add(`${subpath}.js`);
    }
  }
  return privateFileNames;
}

function collectLegacyPublicPluginSdkDistFileNames(params) {
  const privateFileNames = readPrivateLocalOnlyPluginSdkDistFileNames(params.repoRoot);
  const fileNames = new Set();
  for (const dirent of fs.readdirSync(params.pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    if (privateFileNames.has(dirent.name)) {
      continue;
    }
    fileNames.add(dirent.name);
  }
  return fileNames.size > 0 ? fileNames : undefined;
}

function readPublicPluginSdkDistFileNames(params) {
  const packageJson = tryReadJsonFile(path.join(params.repoRoot, "package.json"));
  if (!isRecord(packageJson)) {
    return collectLegacyPublicPluginSdkDistFileNames(params);
  }
  const packageExports = packageJson.exports;
  if (!isRecord(packageExports)) {
    return collectLegacyPublicPluginSdkDistFileNames(params);
  }

  const fileNames = new Set();
  for (const exportKey of Object.keys(packageExports)) {
    if (!exportKey.startsWith("./plugin-sdk/")) {
      continue;
    }
    const subpath = exportKey.slice("./plugin-sdk/".length);
    if (isSafePluginSdkSubpathSegment(subpath)) {
      fileNames.add(`${subpath}.js`);
    }
  }

  return fileNames.size > 0 ? fileNames : collectLegacyPublicPluginSdkDistFileNames(params);
}

function buildRuntimePluginSdkPackageExports(publicDistFileNames) {
  if (!publicDistFileNames) {
    return {};
  }

  const sortedFileNames = [...publicDistFileNames].toSorted((left, right) =>
    left.localeCompare(right),
  );
  return Object.fromEntries(
    sortedFileNames.map((fileName) => {
      const subpath = fileName.slice(0, -".js".length);
      return [`./plugin-sdk/${subpath}`, `./plugin-sdk/${fileName}`];
    }),
  );
}

export function ensureOpenClawExtensionAlias(params) {
  const pluginSdkDir = path.join(params.repoRoot, "dist", "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const publicDistFileNames = readPublicPluginSdkDistFileNames({
    repoRoot: params.repoRoot,
    pluginSdkDir,
  });
  const finalAliasDir = path.join(params.distExtensionsRoot, "node_modules", "openclaw");
  const aliasDir = params.aliasDir ?? finalAliasDir;
  assertRealOutputRoot(aliasDir);
  const pluginSdkAliasPath = path.join(aliasDir, "plugin-sdk");
  fs.mkdirSync(aliasDir, { recursive: true });
  writeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: buildRuntimePluginSdkPackageExports(publicDistFileNames),
  });
  removePathIfExists(pluginSdkAliasPath);
  fs.mkdirSync(pluginSdkAliasPath, { recursive: true });
  for (const dirent of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    if (publicDistFileNames && !publicDistFileNames.has(dirent.name)) {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, dirent.name),
      path.join(pluginSdkAliasPath, dirent.name),
      path.join(finalAliasDir, "plugin-sdk", dirent.name),
    );
  }
}

function hasDefaultExport(sourcePath) {
  const text = fs.readFileSync(sourcePath, "utf8");
  return /\bexport\s+default\b/u.test(text) || /\bas\s+default\b/u.test(text);
}

export function writeRuntimeModuleWrapper(sourcePath, targetPath, finalPath = targetPath) {
  const specifier = (path.relative(path.dirname(finalPath), sourcePath) || ".").replace(/\\/g, "/");
  const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
  const defaultForwarder = hasDefaultExport(sourcePath)
    ? [
        `import defaultModule from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = defaultModule;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ]
    : [
        `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = "default" in module ? module.default : module;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ];
  fs.writeFileSync(
    targetPath,
    [
      `export * from ${JSON.stringify(normalizedSpecifier)};`,
      ...defaultForwarder,
      "export { defaultExport as default };",
      "",
    ].join("\n"),
    "utf8",
  );
}
