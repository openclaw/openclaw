import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

export const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = "dist/channel-catalog.json";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toCatalogInstall(value, packageName) {
  const install = isRecord(value) ? value : {};
  const npmSpec = trimString(install.npmSpec) || packageName;
  if (!npmSpec) {
    return null;
  }
  const defaultChoice = trimString(install.defaultChoice);
  return {
    npmSpec,
    ...(defaultChoice === "npm" || defaultChoice === "local" ? { defaultChoice } : {}),
  };
}

function buildCatalogEntry(packageJson) {
  if (!isRecord(packageJson)) {
    return null;
  }
  const packageName = trimString(packageJson.name);
  const manifest = isRecord(packageJson.openclaw) ? packageJson.openclaw : null;
  const release = manifest && isRecord(manifest.release) ? manifest.release : null;
  const channel = manifest && isRecord(manifest.channel) ? manifest.channel : null;
  if (!packageName || !channel || release?.publishToNpm !== true) {
    return null;
  }
  const install = toCatalogInstall(manifest.install, packageName);
  if (!install) {
    return null;
  }
  const version = trimString(packageJson.version);
  const description = trimString(packageJson.description);
  return {
    name: packageName,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    openclaw: {
      channel,
      install,
    },
  };
}

export function buildOfficialChannelCatalog(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const extensionsRoot = path.join(repoRoot, "extensions");
  const entries = [];
  if (!fs.existsSync(extensionsRoot)) {
    return { entries };
  }

  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsRoot, dirent.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const entry = buildCatalogEntry(packageJson);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // Ignore invalid package metadata and keep generating the rest of the catalog.
    }
  }

  entries.sort((left, right) => {
    const leftId = trimString(left.openclaw?.channel?.id) || left.name;
    const rightId = trimString(right.openclaw?.channel?.id) || right.name;
    return leftId.localeCompare(rightId);
  });

  return { entries };
}

export function writeOfficialChannelCatalog(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
  const catalog = buildOfficialChannelCatalog({ repoRoot });
  writeTextFileIfChanged(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeOfficialChannelCatalog();
}
