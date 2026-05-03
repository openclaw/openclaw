import fs from "node:fs";
import path from "node:path";

/**
 * Static, non-transpiled runtime assets referenced by built extension code.
 *
 * `dest` is the root-package dist path. Package-local runtime builds rewrite it
 * under the plugin package's own dist directory.
 */
export const STATIC_EXTENSION_ASSETS = [
  {
    src: "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
    dest: "dist/extensions/acpx/mcp-proxy.mjs",
  },
  {
    src: "extensions/acpx/src/runtime-internals/error-format.mjs",
    dest: "dist/extensions/acpx/error-format.mjs",
  },
  {
    src: "extensions/acpx/src/runtime-internals/mcp-command-line.mjs",
    dest: "dist/extensions/acpx/mcp-command-line.mjs",
  },
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
  const rootDir = params.rootDir ?? process.cwd();
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

export function copyStaticExtensionAssetsForPackage(params) {
  const rootDir = params.rootDir ?? process.cwd();
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  const fsImpl = params.fs ?? fs;
  const packagePrefix = `extensions/${params.pluginDir}/`;
  const rootDistPrefix = `dist/extensions/${params.pluginDir}/`;
  const copied = [];
  for (const { src, dest } of assets) {
    const normalizedSrc = src.replaceAll("\\", "/");
    const normalizedDest = dest.replaceAll("\\", "/");
    if (!normalizedSrc.startsWith(packagePrefix) || !normalizedDest.startsWith(rootDistPrefix)) {
      continue;
    }
    const srcPath = path.join(rootDir, src);
    if (!fsImpl.existsSync(srcPath)) {
      continue;
    }
    const packageRelativeDest = normalizedDest.slice(rootDistPrefix.length);
    const destPath = path.join(rootDir, packagePrefix, "dist", packageRelativeDest);
    fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
    fsImpl.copyFileSync(srcPath, destPath);
    copied.push(`dist/${packageRelativeDest}`);
  }
  return copied.toSorted((left, right) => left.localeCompare(right));
}
