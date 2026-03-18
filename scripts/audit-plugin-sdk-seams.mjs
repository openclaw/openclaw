#!/usr/bin/env node

import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["src", "extensions", "scripts", "ui", "test"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".turbo", ".next", "build"]);
const BUILTIN_PREFIXES = new Set(["node:"]);
const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);
const INTERNAL_PREFIXES = ["openclaw/plugin-sdk", "openclaw/", "@/", "~/", "#"];
const compareStrings = (a, b) => a.localeCompare(b);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeSlashes(input) {
  return input.split(path.sep).join("/");
}

function listFiles(rootRel) {
  const rootAbs = path.join(REPO_ROOT, rootRel);
  if (!fs.existsSync(rootAbs)) {
    return [];
  }
  const out = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(abs);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!CODE_EXTENSIONS.has(path.extname(entry.name))) {
        continue;
      }
      out.push(abs);
    }
  }
  out.sort((a, b) =>
    normalizeSlashes(path.relative(REPO_ROOT, a)).localeCompare(
      normalizeSlashes(path.relative(REPO_ROOT, b)),
    ),
  );
  return out;
}

function extractSpecifiers(sourceText) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+type\s+[^"'`]*?\sfrom\s+["'`]([^"'`]+)["'`]/g,
    /\bimport\s+[^"'`]*?\sfrom\s+["'`]([^"'`]+)["'`]/g,
    /\bexport\s+[^"'`]*?\sfrom\s+["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function toRepoRelative(absPath) {
  return normalizeSlashes(path.relative(REPO_ROOT, absPath));
}

function resolveRelativeImport(fileAbs, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }
  const fromDir = path.dirname(fileAbs);
  const baseAbs = specifier.startsWith("/")
    ? path.join(REPO_ROOT, specifier)
    : path.resolve(fromDir, specifier);
  const candidatePaths = [
    baseAbs,
    `${baseAbs}.ts`,
    `${baseAbs}.tsx`,
    `${baseAbs}.mts`,
    `${baseAbs}.cts`,
    `${baseAbs}.js`,
    `${baseAbs}.jsx`,
    `${baseAbs}.mjs`,
    `${baseAbs}.cjs`,
    path.join(baseAbs, "index.ts"),
    path.join(baseAbs, "index.tsx"),
    path.join(baseAbs, "index.mts"),
    path.join(baseAbs, "index.cts"),
    path.join(baseAbs, "index.js"),
    path.join(baseAbs, "index.jsx"),
    path.join(baseAbs, "index.mjs"),
    path.join(baseAbs, "index.cjs"),
  ];
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return toRepoRelative(candidate);
    }
  }
  return normalizeSlashes(path.relative(REPO_ROOT, baseAbs));
}

function getExternalPackageRoot(specifier) {
  if (!specifier) {
    return null;
  }
  if (!/^[a-zA-Z0-9@][a-zA-Z0-9@._/+:-]*$/.test(specifier)) {
    return null;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (Array.from(BUILTIN_PREFIXES).some((prefix) => specifier.startsWith(prefix))) {
    return null;
  }
  if (
    INTERNAL_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))
  ) {
    return null;
  }
  if (BUILTIN_MODULES.has(specifier)) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  const root = specifier.split("/")[0] ?? specifier;
  if (BUILTIN_MODULES.has(root)) {
    return null;
  }
  return root;
}

function ensureArrayMap(map, key) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  return map.get(key);
}

const packageJson = readJson(path.join(REPO_ROOT, "package.json"));
const declaredPackages = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
]);

const fileRecords = [];
const publicSeamUsage = new Map();
const sourceSeamUsage = new Map();
const missingExternalUsage = new Map();

for (const root of SCAN_ROOTS) {
  for (const fileAbs of listFiles(root)) {
    const fileRel = toRepoRelative(fileAbs);
    const sourceText = fs.readFileSync(fileAbs, "utf8");
    const specifiers = extractSpecifiers(sourceText);
    const publicSeams = new Set();
    const sourceSeams = new Set();
    const externalPackages = new Set();

    for (const specifier of specifiers) {
      if (specifier === "openclaw/plugin-sdk") {
        publicSeams.add("index");
        ensureArrayMap(publicSeamUsage, "index").push(fileRel);
        continue;
      }
      if (specifier.startsWith("openclaw/plugin-sdk/")) {
        const seam = specifier.slice("openclaw/plugin-sdk/".length);
        publicSeams.add(seam);
        ensureArrayMap(publicSeamUsage, seam).push(fileRel);
        continue;
      }

      const resolvedRel = resolveRelativeImport(fileAbs, specifier);
      if (resolvedRel?.startsWith("src/plugin-sdk/")) {
        const seam = resolvedRel
          .slice("src/plugin-sdk/".length)
          .replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, "")
          .replace(/\/index$/, "");
        sourceSeams.add(seam);
        ensureArrayMap(sourceSeamUsage, seam).push(fileRel);
        continue;
      }

      const externalRoot = getExternalPackageRoot(specifier);
      if (!externalRoot) {
        continue;
      }
      externalPackages.add(externalRoot);
      if (!declaredPackages.has(externalRoot)) {
        ensureArrayMap(missingExternalUsage, externalRoot).push(fileRel);
      }
    }

    fileRecords.push({
      file: fileRel,
      publicSeams: [...publicSeams].toSorted(compareStrings),
      sourceSeams: [...sourceSeams].toSorted(compareStrings),
      externalPackages: [...externalPackages].toSorted(compareStrings),
    });
  }
}

fileRecords.sort((a, b) => a.file.localeCompare(b.file));

const overlapFiles = fileRecords
  .filter((record) => record.publicSeams.length > 0 && record.sourceSeams.length > 0)
  .map((record) => ({
    file: record.file,
    publicSeams: record.publicSeams,
    sourceSeams: record.sourceSeams,
    overlappingSeams: record.publicSeams.filter((seam) => record.sourceSeams.includes(seam)),
  }))
  .toSorted((a, b) => a.file.localeCompare(b.file));

const seamFamilies = [...new Set([...publicSeamUsage.keys(), ...sourceSeamUsage.keys()])]
  .toSorted((a, b) => a.localeCompare(b))
  .map((seam) => ({
    seam,
    publicImporterCount: new Set(publicSeamUsage.get(seam) ?? []).size,
    sourceImporterCount: new Set(sourceSeamUsage.get(seam) ?? []).size,
    publicImporters: [...new Set(publicSeamUsage.get(seam) ?? [])].toSorted(compareStrings),
    sourceImporters: [...new Set(sourceSeamUsage.get(seam) ?? [])].toSorted(compareStrings),
  }))
  .filter((entry) => entry.publicImporterCount > 0 || entry.sourceImporterCount > 0);

const duplicatedSeamFamilies = seamFamilies.filter(
  (entry) => entry.publicImporterCount > 0 && entry.sourceImporterCount > 0,
);

const missingPackages = [...missingExternalUsage.entries()]
  .map(([packageName, files]) => {
    const uniqueFiles = [...new Set(files)].toSorted(compareStrings);
    const byTopLevel = {};
    for (const file of uniqueFiles) {
      const topLevel = file.split("/")[0] ?? file;
      byTopLevel[topLevel] ??= [];
      byTopLevel[topLevel].push(file);
    }
    const topLevelCounts = Object.entries(byTopLevel)
      .map(([scope, scopeFiles]) => ({
        scope,
        fileCount: scopeFiles.length,
      }))
      .toSorted((a, b) => b.fileCount - a.fileCount || a.scope.localeCompare(b.scope));
    return {
      packageName,
      importerCount: uniqueFiles.length,
      importers: uniqueFiles,
      topLevelCounts,
    };
  })
  .toSorted(
    (a, b) => b.importerCount - a.importerCount || a.packageName.localeCompare(b.packageName),
  );

const summary = {
  scannedFileCount: fileRecords.length,
  filesUsingPublicPluginSdk: fileRecords.filter((record) => record.publicSeams.length > 0).length,
  filesUsingSourcePluginSdk: fileRecords.filter((record) => record.sourceSeams.length > 0).length,
  filesUsingBothPublicAndSourcePluginSdk: overlapFiles.length,
  duplicatedSeamFamilyCount: duplicatedSeamFamilies.length,
  missingExternalPackageCount: missingPackages.length,
};

const report = {
  generatedAtUtc: new Date().toISOString(),
  repoRoot: REPO_ROOT,
  summary,
  duplicatedSeamFamilies,
  overlapFiles,
  missingPackages,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
