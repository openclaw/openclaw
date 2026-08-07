// Prepares the trusted harness manifest for npm Telegram live E2E scenarios.
import fs from "node:fs";

const packageJsonPaths = process.argv.slice(2);
if (packageJsonPaths.length !== 1) {
  throw new Error("expected exactly one trusted harness package.json path");
}

const privatePluginSdkSubpaths = JSON.parse(
  fs.readFileSync(
    new URL("../../../lib/plugin-sdk-private-local-only-subpaths.json", import.meta.url),
    "utf8",
  ),
);
const packageJsonPath = packageJsonPaths[0];
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
pkg.exports = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};

for (const subpath of [...privatePluginSdkSubpaths, "gateway-runtime"]) {
  const exportPath = `./plugin-sdk/${subpath}`;
  if (!pkg.exports[exportPath]) {
    pkg.exports[exportPath] = {
      types: `./dist/plugin-sdk/${subpath}.d.ts`,
      default: `./dist/plugin-sdk/${subpath}.js`,
    };
  }
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
