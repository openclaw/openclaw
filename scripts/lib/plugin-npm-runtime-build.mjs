import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import {
  collectPluginSourceEntries,
  collectTopLevelPublicSurfaceEntries,
} from "./bundled-plugin-build-entries.mjs";
import { copyStaticExtensionAssetsForPackage } from "./static-extension-assets.mjs";

const env = {
  NODE_ENV: "production",
};

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizePackageEntry(value) {
  return typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
}

function isTypeScriptEntry(entry) {
  return /\.(?:c|m)?ts$/u.test(entry);
}

function toPackageRuntimeEntry(entry) {
  const normalized = normalizePackageEntry(entry).replace(/^\.\//u, "");
  return `./dist/${normalized.replace(/\.[^.]+$/u, ".js")}`;
}

function collectExternalDependencyNames(packageJson) {
  return new Set(
    [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ].filter(Boolean),
  );
}

function createNeverBundleDependencyMatcher(packageJson) {
  const externalDependencies = collectExternalDependencyNames(packageJson);
  return (id) => {
    if (id === "openclaw" || id.startsWith("openclaw/")) {
      return true;
    }
    for (const dependency of externalDependencies) {
      if (id === dependency || id.startsWith(`${dependency}/`)) {
        return true;
      }
    }
    return false;
  };
}

function packageEntryKey(entry) {
  return normalizePackageEntry(entry)
    .replace(/^\.\//u, "")
    .replace(/\.[^.]+$/u, "");
}

function resolvePackageDir(repoRoot, packageDir) {
  return path.isAbsolute(packageDir) ? packageDir : path.resolve(repoRoot, packageDir);
}

export function resolvePluginNpmRuntimeBuildPlan(params) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const packageJson = readJsonFile(packageJsonPath);
  if (packageJson.openclaw?.release?.publishToNpm !== true) {
    return null;
  }

  const packageEntries = collectPluginSourceEntries(packageJson).map(normalizePackageEntry);
  const requiresRuntimeBuild = packageEntries.some(isTypeScriptEntry);
  if (!requiresRuntimeBuild) {
    return null;
  }

  const pluginDir = path.basename(packageDir);
  const sourceEntries = [
    ...new Set([
      ...packageEntries,
      ...collectTopLevelPublicSurfaceEntries(packageDir).map(normalizePackageEntry),
    ]),
  ].filter(Boolean);
  const entry = Object.fromEntries(
    sourceEntries.map((sourceEntry) => [
      packageEntryKey(sourceEntry),
      path.join(packageDir, sourceEntry.replace(/^\.\//u, "")),
    ]),
  );

  return {
    repoRoot,
    packageDir,
    pluginDir,
    packageJson,
    sourceEntries,
    entry,
    outDir: path.join(packageDir, "dist"),
    runtimeExtensions: (Array.isArray(packageJson.openclaw?.extensions)
      ? packageJson.openclaw.extensions
      : []
    )
      .map(normalizePackageEntry)
      .filter(Boolean)
      .map(toPackageRuntimeEntry),
    runtimeSetupEntry: normalizePackageEntry(packageJson.openclaw?.setupEntry)
      ? toPackageRuntimeEntry(packageJson.openclaw.setupEntry)
      : undefined,
  };
}

export async function buildPluginNpmRuntime(params) {
  const plan = resolvePluginNpmRuntimeBuildPlan(params);
  if (!plan) {
    return null;
  }

  fs.rmSync(plan.outDir, { recursive: true, force: true });
  await build({
    clean: false,
    config: false,
    dts: false,
    deps: {
      neverBundle: createNeverBundleDependencyMatcher(plan.packageJson),
    },
    entry: plan.entry,
    env,
    fixedExtension: false,
    logLevel: params.logLevel ?? "info",
    outDir: plan.outDir,
    platform: "node",
  });
  const copiedStaticAssets = copyStaticExtensionAssetsForPackage({
    rootDir: plan.repoRoot,
    pluginDir: plan.pluginDir,
  });
  return {
    ...plan,
    copiedStaticAssets,
  };
}

function parseArgs(argv) {
  const packageDir = argv[0];
  if (!packageDir) {
    throw new Error("usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir>");
  }
  return { packageDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { packageDir } = parseArgs(process.argv.slice(2));
    const result = await buildPluginNpmRuntime({ packageDir });
    if (result) {
      console.error(
        `[plugin-npm-runtime-build] built ${result.pluginDir} runtime (${result.sourceEntries.length} entries)`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
