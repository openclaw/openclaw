import fs from "node:fs";
import path from "node:path";

export function resolveTsgoInvocation(repoRoot, { nodePath = process.execPath } = {}) {
  const tsgoScriptPath = path.resolve(
    repoRoot,
    "node_modules",
    "@typescript",
    "native-preview",
    "bin",
    "tsgo.js",
  );
  if (!fs.existsSync(tsgoScriptPath)) {
    throw new Error(`tsgo entrypoint not found at ${tsgoScriptPath}`);
  }

  return {
    command: nodePath,
    argsPrefix: [tsgoScriptPath],
  };
}
