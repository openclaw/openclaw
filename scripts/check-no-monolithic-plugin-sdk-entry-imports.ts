import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { discoverOpenClawPlugins } from "../src/plugins/discovery.js";

// Match exact monolithic-root specifier in any code path:
// imports/exports, require/dynamic import, and test mocks (vi.mock/jest.mock).
const ROOT_IMPORT_PATTERN = /["']openclaw\/plugin-sdk["']/;

function hasMonolithicRootImport(content: string): boolean {
  return ROOT_IMPORT_PATTERN.test(content);
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

function loadTrackedFiles(rootDir: string): Set<string> {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tracked = new Set<string>();
    for (const file of output.split("\0")) {
      if (file) {
        tracked.add(file);
      }
    }
    return tracked;
  } catch {
    return new Set<string>();
  }
}

function toGitRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function main() {
  const cwd = process.cwd();
  const trackedFiles = loadTrackedFiles(cwd);
  const discovery = discoverOpenClawPlugins({});
  const bundledCandidates = discovery.candidates.filter((c) => c.origin === "bundled");
  const filesToCheck = new Set<string>();
  for (const candidate of bundledCandidates) {
    filesToCheck.add(candidate.source);
    for (const srcFile of collectPluginSourceFiles(candidate.rootDir)) {
      filesToCheck.add(srcFile);
    }
  }

  const offenders: string[] = [];
  for (const entryFile of filesToCheck) {
    const relative = toGitRelativePath(cwd, entryFile);
    // Ignore stale untracked files (e.g. from runner caches/workspace reuse).
    if (trackedFiles.size > 0 && !trackedFiles.has(relative)) {
      continue;
    }
    let content = "";
    try {
      content = fs.readFileSync(entryFile, "utf8");
    } catch {
      continue;
    }
    if (hasMonolithicRootImport(content)) {
      offenders.push(entryFile);
    }
  }

  if (offenders.length > 0) {
    console.error("Bundled plugin source files must not import monolithic openclaw/plugin-sdk.");
    for (const file of offenders.toSorted()) {
      const relative = path.relative(process.cwd(), file) || file;
      console.error(`- ${relative}`);
    }
    console.error(
      "Use openclaw/plugin-sdk/<channel> for channel plugins, /core for startup surfaces, or /compat for broader internals.",
    );
    process.exit(1);
  }

  console.log(
    `OK: bundled plugin source files use scoped plugin-sdk subpaths (${filesToCheck.size} checked).`,
  );
}

main();
