import fs from "node:fs";
import path from "node:path";
import { shouldBuildBundledCluster } from "./optional-bundled-clusters.mjs";

function readBundledPluginPackageJson(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function collectPluginSourceEntries(packageJson) {
  let packageEntries = Array.isArray(packageJson?.openclaw?.extensions)
    ? packageJson.openclaw.extensions.filter(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const setupEntry =
    typeof packageJson?.openclaw?.setupEntry === "string" &&
    packageJson.openclaw.setupEntry.trim().length > 0
      ? packageJson.openclaw.setupEntry
      : undefined;
  if (setupEntry) {
    packageEntries = Array.from(new Set([...packageEntries, setupEntry]));
  }
  return packageEntries.length > 0 ? packageEntries : ["./index.ts"];
}

export function collectBundledPluginBuildEntries(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const extensionsRoot = path.join(cwd, "extensions");
  const entries = [];

  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = readBundledPluginPackageJson(packageJsonPath);
    if (!shouldBuildBundledCluster(dirent.name, env, { packageJson })) {
      continue;
    }

    entries.push({
      id: dirent.name,
      hasPackageJson: packageJson !== null,
      packageJson,
      sourceEntries: collectPluginSourceEntries(packageJson),
    });
  }

  return entries;
}

export function listBundledPluginBuildEntries(params = {}) {
  return Object.fromEntries(
    collectBundledPluginBuildEntries(params).flatMap(({ id, sourceEntries }) =>
      sourceEntries.map((entry) => {
        const normalizedEntry = entry.replace(/^\.\//, "");
        const entryKey = `extensions/${id}/${normalizedEntry.replace(/\.[^.]+$/u, "")}`;
        return [entryKey, path.join("extensions", id, normalizedEntry)];
      }),
    ),
  );
}

export function listBundledPluginPackArtifacts(params = {}) {
  const entries = collectBundledPluginBuildEntries(params);
  const artifacts = new Set();

  for (const { id, hasPackageJson, sourceEntries } of entries) {
    artifacts.add(`dist/extensions/${id}/openclaw.plugin.json`);
    if (hasPackageJson) {
      artifacts.add(`dist/extensions/${id}/package.json`);
    }
    for (const entry of sourceEntries) {
      const normalizedEntry = entry.replace(/^\.\//, "").replace(/\.[^.]+$/u, "");
      artifacts.add(`dist/extensions/${id}/${normalizedEntry}.js`);
    }
  }

  return [...artifacts].toSorted((left, right) => left.localeCompare(right));
}
