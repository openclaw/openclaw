import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const pkgPath = join(__dirname, "..", "package.json");
const original = readFileSync(pkgPath, "utf-8");
const pkg = JSON.parse(original);

// Store original name and swap to unscoped version for VSIX
const originalName = pkg.name;
pkg.name = "pierre-theme";

console.log(`Temporarily renaming package: ${originalName} → ${pkg.name}\n`);

try {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  execSync("vsce package", { stdio: "inherit", cwd: join(__dirname, "..") });
} finally {
  // Always restore original package.json
  writeFileSync(pkgPath, original);
  console.log(`\nRestored package name: ${originalName}`);
}
