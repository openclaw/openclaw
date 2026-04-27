import fs from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;

/**
 * Copy static (non-transpiled) runtime assets that are referenced by their
 * source-relative path inside bundled extension code.
 *
 * Each entry: { src: repo-root-relative source, dest: dist-relative dest }
 */
export const STATIC_EXTENSION_ASSETS = [
  // acpx MCP proxy — co-deployed alongside the acpx index bundle so that
  // `path.resolve(dirname(import.meta.url), "mcp-proxy.mjs")` resolves correctly
  // at runtime from the built ACPX extension directory.
  {
    src: "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
    dest: "dist/extensions/acpx/mcp-proxy.mjs",
  },
  // diffs viewer runtime bundle — co-deployed inside the plugin package so the
  // built bundle can resolve `./assets/viewer-runtime.js` from dist.
  {
    src: "extensions/diffs/assets/viewer-runtime.js",
    dest: "dist/extensions/diffs/assets/viewer-runtime.js",
  },
];

export function listStaticExtensionAssetOutputs(params = {}) {
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  return assets
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function copyStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  const fsImpl = params.fs ?? fs;
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const srcPath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    if (fsImpl.existsSync(srcPath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(srcPath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

function extractNamedRuntimeExports(sourceText) {
  const names = new Set();
  const exportBlockRe = /export\s*\{([^}]+)\}/g;
  for (const match of sourceText.matchAll(exportBlockRe)) {
    const block = match[1] ?? "";
    for (const part of block.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      const aliased = trimmed.match(
        /^(?:type\s+)?(?<local>[A-Za-z_$][\w$]*)(?:\s+as\s+(?<exported>[A-Za-z_$][\w$]*))?$/u,
      );
      const exported = aliased?.groups?.exported ?? aliased?.groups?.local;
      if (exported) {
        names.add(exported);
      }
    }
  }
  return [...names];
}

function resolveSourceDrivenRuntimeAliasTarget(params) {
  const { srcFilePath, distFileNames, distDir, fsImpl } = params;
  const aliasFileName = path.basename(srcFilePath).replace(/\.ts$/u, ".js");
  const stemWithoutRuntime = aliasFileName.replace(/\.runtime\.js$/u, "");
  const candidates = distFileNames.filter((name) =>
    new RegExp(
      `^${stemWithoutRuntime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Za-z0-9_-]+\\.js$`,
      "u",
    ).test(name),
  );
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const sourceText = fsImpl.readFileSync(srcFilePath, "utf8");
  const exportNames = extractNamedRuntimeExports(sourceText);
  if (exportNames.length === 0) {
    return null;
  }
  const matches = candidates.filter((name) => {
    const text = fsImpl.readFileSync(path.join(distDir, name), "utf8");
    return exportNames.every((exportName) => text.includes(exportName));
  });
  return matches.length === 1 ? matches[0] : null;
}

export function writeStableRootRuntimeAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const srcDir = path.join(rootDir, "src");
  const fsImpl = params.fs ?? fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  const distFileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    const aliasPath = path.join(distDir, `${match.groups.base}.js`);
    writeTextFileIfChanged(aliasPath, `export * from "./${entry.name}";\n`);
  }

  for (const srcFilePath of globSync(path.join(srcDir, "**", "*.runtime.ts"))) {
    const aliasFileName = path.basename(srcFilePath).replace(/\.ts$/u, ".js");
    const aliasPath = path.join(distDir, aliasFileName);
    if (fsImpl.existsSync(aliasPath)) {
      continue;
    }
    const target = resolveSourceDrivenRuntimeAliasTarget({
      srcFilePath,
      distFileNames,
      distDir,
      fsImpl,
    });
    if (!target) {
      continue;
    }
    writeTextFileIfChanged(aliasPath, `export * from "./${target}";\n`);
  }
}

export function runRuntimePostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  writeOfficialChannelCatalog(params);
  stageBundledPluginRuntimeDeps(params);
  stageBundledPluginRuntime(params);
  writeStableRootRuntimeAliases(params);
  copyStaticExtensionAssets(params);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
