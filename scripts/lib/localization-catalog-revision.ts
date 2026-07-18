import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function computeLocalizationCatalogRevision(
  repoRoot: string,
  relativePaths: readonly string[],
): string {
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    for (const filePath of listRegularFiles(absolutePath)) {
      hash.update(path.relative(repoRoot, filePath).replaceAll("\\", "/"));
      hash.update("\0");
      hash.update(fs.readFileSync(filePath));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export function listRegularFiles(entryPath: string): string[] {
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Localization catalog paths cannot contain symlinks: ${entryPath}`);
  }
  if (stat.isFile()) {
    return [entryPath];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Localization catalog path must be a file or directory: ${entryPath}`);
  }
  return fs
    .readdirSync(entryPath, { withFileTypes: true })
    .flatMap((entry) => listRegularFiles(path.join(entryPath, entry.name)))
    .toSorted();
}
