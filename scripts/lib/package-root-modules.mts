import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// Static, re-export, side-effect and dynamic imports of a package-root sibling.
// Subdirectory specifiers (./dist/, ./scripts/) belong to other staging owners.
const siblingImportPattern = /\b(?:from|import)\s*\(?\s*["']\.\/([^"'/]+\.mjs)["']/g;

/** Package-root `.mjs` siblings that one package-root module imports. */
export function readPackageRootImports(file: string, root = repoRoot): string[] {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  return [...new Set(Array.from(source.matchAll(siblingImportPattern), (match) => match[1]!))];
}

/**
 * Close package-root entry modules over their sibling imports, so fixtures that
 * stage launcher modules copy every file the entries load.
 */
export function collectPackageRootModules(entries: readonly string[], root = repoRoot): string[] {
  const closure = new Set(entries);
  const importers = new Map<string, string>();
  for (const file of closure) {
    if (!fs.existsSync(path.join(root, file))) {
      const importer = importers.get(file);
      throw new Error(
        importer ? `${importer} imports missing ./${file}` : `missing entry module ${file}`,
      );
    }
    for (const dependency of readPackageRootImports(file, root)) {
      if (!closure.has(dependency)) {
        importers.set(dependency, file);
        closure.add(dependency);
      }
    }
  }
  return [...closure].toSorted();
}
