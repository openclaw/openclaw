import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionsDir = path.join(rootDir, "extensions");

const rootPkgPath = path.join(rootDir, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

const foundDeps: Record<string, string> = {};

if (fs.existsSync(extensionsDir)) {
  const extensions = fs.readdirSync(extensionsDir);
  for (const ext of extensions) {
    const pkgPath = path.join(extensionsDir, ext, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.dependencies) {
          for (const [name, version] of Object.entries(pkg.dependencies)) {
            // Skip workspace protocols if any, though usually they are versions
            foundDeps[name] = version as string;
          }
        }
      } catch (e) {
        console.error(`Failed to read ${pkgPath}:`, e);
      }
    }
  }
}

let changed = false;

if (!rootPkg.dependencies) {
  rootPkg.dependencies = {};
}
if (!rootPkg.bundledDependencies) {
  rootPkg.bundledDependencies = [];
}

for (const [name, version] of Object.entries(foundDeps)) {
  // Add to dependencies if missing
  if (!rootPkg.dependencies[name]) {
    rootPkg.dependencies[name] = version;
    changed = true;
  }

  // Add to bundledDependencies
  if (!rootPkg.bundledDependencies.includes(name)) {
    rootPkg.bundledDependencies.push(name);
    changed = true;
  }
}

// Sort bundledDependencies for deterministic output
rootPkg.bundledDependencies.sort();

if (changed) {
  console.log("Syncing plugin dependencies to root package.json...");
  fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
} else {
  console.log("Plugin dependencies are in sync.");
}
