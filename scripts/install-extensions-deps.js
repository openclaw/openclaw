import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionsDir = path.join(__dirname, "..", "extensions");

async function hasDependencies(dir) {
  try {
    const pkgJson = path.join(dir, "package.json");
    const stat = await fs.stat(pkgJson);
    if (!stat.isFile()) return false;
    const content = await fs.readFile(pkgJson, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
  } catch {
    return false;
  }
}

async function installDeps(dir) {
  const { execSync } = await import("node:child_process");
  try {
    console.log(`Installing dependencies for ${path.basename(dir)}...`);
    execSync("npm install --omit=dev --ignore-scripts", {
      cwd: dir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error(`Failed to install deps for ${path.basename(dir)}:`, err.message);
  }
}

async function main() {
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(extensionsDir, entry.name);
    if (await hasDependencies(dir)) {
      await installDeps(dir);
    }
  }
}

main();
