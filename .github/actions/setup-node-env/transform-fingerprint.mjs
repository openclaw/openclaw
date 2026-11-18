import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const hash = createHash("sha256");
let files = 0;
const excluded = new Set([
  "test/vitest/vitest.database-worker-core-paths.mjs",
  "test/vitest/vitest.extension-database-workers-paths.mjs",
  "test/vitest/vitest.ui-e2e.config.ts",
  "test/vitest/vitest.unit-fast-paths.mjs",
]);

function isTransformInput(file, name) {
  return (
    file === "pnpm-lock.yaml" ||
    file === "pnpm-workspace.yaml" ||
    name === "package.json" ||
    (name.startsWith("tsconfig") && name.endsWith(".json")) ||
    (name.startsWith("vitest") && name.includes(".config.", 6)) ||
    file === "test/vitest" ||
    file.startsWith("test/vitest/") ||
    (file.startsWith("src/state/") && !file.slice(10).includes("/") && name.endsWith(".sql"))
  );
}

function walk(directory = "", inherited = false) {
  // Match hashFiles' depth-first readdir order, including hidden and untracked
  // inputs. Dirents avoid a separate lstat for every unrelated source file.
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.name === "node_modules" || file === ".ci-harness" || excluded.has(file)) {
      continue;
    }
    const include = inherited || isTransformInput(file, entry.name);
    if (entry.isDirectory()) {
      // hashFiles also includes descendants when an input pattern matches a directory.
      walk(file, include);
    } else if (include) {
      const absolute = path.join(root, file);
      // Keep file aliases as separate inputs; do not follow directory symlinks.
      // A missing or unreadable selected target must still fail setup.
      if (entry.isSymbolicLink() && statSync(absolute).isDirectory()) {
        continue;
      }
      hash.update(createHash("sha256").update(readFileSync(absolute)).digest());
      files++;
    }
  }
}

walk();
console.log(files ? hash.digest("hex") : "");
