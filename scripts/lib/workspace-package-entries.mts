import fs from "node:fs";
import path from "node:path";

/** Canonical source entries for workspace packages with dist ESM exports. */
export function buildPackageDistEntriesFromExports(packageDir: string): Record<string, string> {
  const packageJsonPath = path.join("packages", packageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const entries: Record<string, string> = {};
  for (const [exportKey, value] of Object.entries(packageJson.exports ?? {})) {
    const entry =
      exportKey === "." ? "index" : exportKey.startsWith("./") ? exportKey.slice(2) : "";
    if (!entry || entry.includes("..")) {
      continue;
    }
    const importPath =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).import
        : value;
    if (typeof importPath !== "string" || !importPath.startsWith("./dist/")) {
      continue;
    }
    const sourcePath = importPath
      .replace(/^\.\/dist\//u, `packages/${packageDir}/src/`)
      .replace(/\.mjs$/u, ".ts");
    entries[entry] = sourcePath;
  }
  return Object.fromEntries(Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b)));
}
