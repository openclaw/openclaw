import fs from "node:fs";
import path from "node:path";
import { discoverOpenClawPlugins } from "../src/plugins/discovery.js";

// Match exact monolithic-root specifier in any code path:
// imports/exports, require/dynamic import, and test mocks (vi.mock/jest.mock).
const ROOT_IMPORT_PATTERN = /["']openclaw\/plugin-sdk["']/;
const LEGACY_COMPAT_IMPORT_PATTERN = /["']openclaw\/plugin-sdk\/compat["']/;

function hasMonolithicRootImport(content: string): boolean {
  return ROOT_IMPORT_PATTERN.test(content);
}

function hasLegacyCompatImport(content: string): boolean {
  return LEGACY_COMPAT_IMPORT_PATTERN.test(content);
}

function isSourceFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(filePath);
}

function collectPluginSourceFiles(rootDir: string): string[] {
  const srcDir = path.join(rootDir, "src");
  if (!fs.existsSync(srcDir)) {
    return [];
  }

  const files: string[] = [];
  const stack: string[] = [srcDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === ".git" ||
          entry.name === "coverage"
        ) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isSourceFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectSharedExtensionSourceFiles(): string[] {
  return collectPluginSourceFiles(path.join(process.cwd(), "extensions", "shared"));
}

function collectBundledExtensionSourceFiles(): string[] {
  const extensionsDir = path.join(process.cwd(), "extensions");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "shared") {
      continue;
    }
    for (const srcFile of collectPluginSourceFiles(path.join(extensionsDir, entry.name))) {
      files.push(srcFile);
    }
  }
  return files;
}

function main() {
  const discovery = discoverOpenClawPlugins({});
  const bundledCandidates = discovery.candidates.filter((c) => c.origin === "bundled");
  const filesToCheck = new Set<string>();
  for (const candidate of bundledCandidates) {
    filesToCheck.add(candidate.source);
    for (const srcFile of collectPluginSourceFiles(candidate.rootDir)) {
      filesToCheck.add(srcFile);
    }
  }
  for (const sharedFile of collectSharedExtensionSourceFiles()) {
    filesToCheck.add(sharedFile);
  }
  for (const extensionFile of collectBundledExtensionSourceFiles()) {
    filesToCheck.add(extensionFile);
  }

  const monolithicOffenders: string[] = [];
  const legacyCompatOffenders: string[] = [];
  for (const entryFile of filesToCheck) {
    let content = "";
    try {
      content = fs.readFileSync(entryFile, "utf8");
    } catch {
      continue;
    }
    if (hasMonolithicRootImport(content)) {
      monolithicOffenders.push(entryFile);
    }
    if (hasLegacyCompatImport(content)) {
      legacyCompatOffenders.push(entryFile);
    }
  }

  if (monolithicOffenders.length > 0 || legacyCompatOffenders.length > 0) {
    if (monolithicOffenders.length > 0) {
      console.error("Bundled plugin source files must not import monolithic openclaw/plugin-sdk.");
      for (const file of monolithicOffenders.toSorted()) {
        const relative = path.relative(process.cwd(), file) || file;
        console.error(`- ${relative}`);
      }
    }
    if (legacyCompatOffenders.length > 0) {
      console.error(
        "Bundled plugin source files must not import legacy openclaw/plugin-sdk/compat.",
      );
      for (const file of legacyCompatOffenders.toSorted()) {
        const relative = path.relative(process.cwd(), file) || file;
        console.error(`- ${relative}`);
      }
    }
    if (monolithicOffenders.length > 0 || legacyCompatOffenders.length > 0) {
      console.error(
        "Use openclaw/plugin-sdk/<domain> or openclaw/plugin-sdk/<channel> subpaths for bundled plugins; root and compat are legacy surfaces only.",
      );
    }
    process.exit(1);
  }

  console.log(
    `OK: bundled plugin source files use scoped plugin-sdk subpaths (${filesToCheck.size} checked).`,
  );
}

main();
