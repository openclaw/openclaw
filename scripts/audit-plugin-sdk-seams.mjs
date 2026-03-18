#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const workspacePackagePaths = ["ui/package.json"];
const compareStrings = (left, right) => left.localeCompare(right);

async function collectWorkspacePackagePaths() {
  const extensionsRoot = path.join(repoRoot, "extensions");
  const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      workspacePackagePaths.push(path.join("extensions", entry.name, "package.json"));
    }
  }
}

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isCodeFile(fileName) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(fileName);
}

function isProductionLikeFile(relativePath) {
  return (
    !/(^|\/)(__tests__|fixtures)\//.test(relativePath) &&
    !/\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath)
  );
}

async function walkCodeFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isCodeFile(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(fullPath);
      if (!isProductionLikeFile(relativePath)) {
        continue;
      }
      out.push(fullPath);
    }
  }
  await walk(rootDir);
  return out.toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function toLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function resolveRelativeSpecifier(specifier, importerFile) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  return normalizePath(path.resolve(path.dirname(importerFile), specifier));
}

function normalizePluginSdkFamily(resolvedPath) {
  const relative = resolvedPath.replace(/^src\/plugin-sdk\//, "");
  return relative.replace(/\.(m|c)?[jt]sx?$/, "");
}

function compareImports(left, right) {
  return (
    left.family.localeCompare(right.family) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier)
  );
}

function collectPluginSdkImports(filePath, sourceFile) {
  const entries = [];

  function push(kind, specifierNode, specifier) {
    const resolvedPath = resolveRelativeSpecifier(specifier, filePath);
    if (!resolvedPath?.startsWith("src/plugin-sdk/")) {
      return;
    }
    entries.push({
      family: normalizePluginSdkFamily(resolvedPath),
      file: normalizePath(filePath),
      kind,
      line: toLine(sourceFile, specifierNode),
      resolvedPath,
      specifier,
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push("import", node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push("export", node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      push("dynamic-import", node.arguments[0], node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return entries;
}

async function collectCorePluginSdkImports() {
  const files = await walkCodeFiles(srcRoot);
  const inventory = [];
  for (const filePath of files) {
    if (normalizePath(filePath).startsWith("src/plugin-sdk/")) {
      continue;
    }
    const source = await fs.readFile(filePath, "utf8");
    const scriptKind =
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    inventory.push(...collectPluginSdkImports(filePath, sourceFile));
  }
  return inventory.toSorted(compareImports);
}

function buildDuplicatedSeamFamilies(inventory) {
  const grouped = new Map();
  for (const entry of inventory) {
    const bucket = grouped.get(entry.family) ?? [];
    bucket.push(entry);
    grouped.set(entry.family, bucket);
  }

  const duplicated = Object.fromEntries(
    [...grouped.entries()]
      .map(([family, entries]) => {
        const files = [...new Set(entries.map((entry) => entry.file))].toSorted(compareStrings);
        return [
          family,
          {
            count: entries.length,
            files,
            imports: entries,
          },
        ];
      })
      .filter(([, value]) => value.files.length > 1)
      .toSorted((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0])),
  );

  return duplicated;
}

function buildOverlapFiles(inventory) {
  const byFile = new Map();
  for (const entry of inventory) {
    const bucket = byFile.get(entry.file) ?? [];
    bucket.push(entry);
    byFile.set(entry.file, bucket);
  }

  return [...byFile.entries()]
    .map(([file, entries]) => {
      const families = [...new Set(entries.map((entry) => entry.family))].toSorted(compareStrings);
      return {
        file,
        families,
        imports: entries,
      };
    })
    .filter((entry) => entry.families.length > 1)
    .toSorted((left, right) => {
      return (
        right.families.length - left.families.length ||
        right.imports.length - left.imports.length ||
        left.file.localeCompare(right.file)
      );
    });
}

function packageClusterMeta(relativePackagePath) {
  if (relativePackagePath === "ui/package.json") {
    return {
      cluster: "ui",
      packageName: "openclaw-control-ui",
      packagePath: relativePackagePath,
      reachability: "workspace-ui",
    };
  }
  const cluster = relativePackagePath.split("/")[1];
  return {
    cluster,
    packageName: null,
    packagePath: relativePackagePath,
    reachability: relativePackagePath.startsWith("extensions/")
      ? "extension-workspace"
      : "workspace",
  };
}

async function buildMissingPackages() {
  const rootPackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const rootDeps = new Set([
    ...Object.keys(rootPackage.dependencies ?? {}),
    ...Object.keys(rootPackage.optionalDependencies ?? {}),
    ...Object.keys(rootPackage.devDependencies ?? {}),
  ]);

  const pluginSdkEntrySources = await walkCodeFiles(path.join(repoRoot, "src", "plugin-sdk"));
  const pluginSdkReachability = new Map();
  for (const filePath of pluginSdkEntrySources) {
    const source = await fs.readFile(filePath, "utf8");
    const matches = [...source.matchAll(/from\s+"(\.\.\/\.\.\/extensions\/([^/]+)\/[^"]+)"/g)];
    for (const match of matches) {
      const cluster = match[2];
      const bucket = pluginSdkReachability.get(cluster) ?? new Set();
      bucket.add(normalizePath(filePath));
      pluginSdkReachability.set(cluster, bucket);
    }
  }

  const output = [];
  for (const relativePackagePath of workspacePackagePaths.toSorted(compareStrings)) {
    const packagePath = path.join(repoRoot, relativePackagePath);
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
    } catch {
      continue;
    }
    const missing = Object.keys(pkg.dependencies ?? {})
      .filter((dep) => dep !== "openclaw" && !rootDeps.has(dep))
      .toSorted(compareStrings);
    if (missing.length === 0) {
      continue;
    }
    const meta = packageClusterMeta(relativePackagePath);
    const pluginSdkEntries = [...(pluginSdkReachability.get(meta.cluster) ?? new Set())].toSorted(
      compareStrings,
    );
    output.push({
      cluster: meta.cluster,
      packageName: pkg.name ?? meta.packageName,
      packagePath: relativePackagePath,
      npmSpec: pkg.openclaw?.install?.npmSpec ?? null,
      private: pkg.private === true,
      pluginSdkReachability:
        pluginSdkEntries.length > 0 ? { staticEntryPoints: pluginSdkEntries } : undefined,
      missing,
    });
  }

  return output.toSorted((left, right) => {
    return right.missing.length - left.missing.length || left.cluster.localeCompare(right.cluster);
  });
}

await collectWorkspacePackagePaths();
const inventory = await collectCorePluginSdkImports();
const result = {
  duplicatedSeamFamilies: buildDuplicatedSeamFamilies(inventory),
  overlapFiles: buildOverlapFiles(inventory),
  missingPackages: await buildMissingPackages(),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
