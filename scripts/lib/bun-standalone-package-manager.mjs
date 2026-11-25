import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** npm is a disk program, including its bundled dependencies and their package topology. */
export function planStandalonePackageManager(runtimeRoot) {
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  const manifestPath = require.resolve("npm/package.json");
  const packageRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = [];
  let sizeBytes = 0;
  function collect(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        ["docs", "doc", "man", ".bin"].includes(entry.name) ||
        /^readme(?:\.|$)/i.test(entry.name) ||
        /(?:\.map|\.d\.[cm]?ts|\.tsbuildinfo)$/.test(entry.name)
      ) {
        continue;
      }
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(source, name);
      } else {
        const canonical = fs.realpathSync(source);
        const contained = path.relative(packageRoot, canonical);
        if (
          contained.startsWith(`..${path.sep}`) ||
          contained === ".." ||
          path.isAbsolute(contained)
        ) {
          throw new Error(`npm runtime resource escapes its package: ${source}`);
        }
        const stat = fs.statSync(canonical);
        if (!stat.isFile()) {
          throw new Error(`npm runtime resource is not a regular file: ${source}`);
        }
        files.push({
          source: path.relative(runtimeRoot, canonical).split(path.sep).join("/"),
          destination: `npm/${name}`,
          category: "packageManager",
        });
        sizeBytes += stat.size;
      }
    }
  }
  for (const name of ["package.json", "LICENSE", "bin/npm-cli.js"]) {
    const source = path.join(packageRoot, name);
    files.push({
      source: path.relative(runtimeRoot, source).split(path.sep).join("/"),
      destination: `npm/${name}`,
      category: "packageManager",
    });
    sizeBytes += fs.statSync(source).size;
  }
  collect(path.join(packageRoot, "lib"), "lib");
  collect(path.join(packageRoot, "node_modules"), "node_modules");
  return {
    files,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      entrypoint: "npm/bin/npm-cli.js",
      fileCount: files.length,
      sizeBytes,
    },
  };
}
