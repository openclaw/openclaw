import fs from "node:fs";
import path from "node:path";

/** Collect bundled plugin directories excluded from the root package artifact. */
export function collectRootPackageExcludedExtensionDirs(params = {}) {
  const excluded = new Set();
  let files = params.files;
  if (!files) {
    const packageJsonPath = path.join(params.cwd ?? process.cwd(), "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return excluded;
    }
    files = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).files ?? [];
  }
  for (const entry of files) {
    if (typeof entry !== "string") {
      continue;
    }
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (match?.[1]) {
      excluded.add(match[1]);
    }
  }
  return excluded;
}
