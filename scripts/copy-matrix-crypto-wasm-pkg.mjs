import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

/**
 * @param {{
 *   cwd?: string;
 *   repoRoot?: string;
 * }} [params]
 */
export function copyMatrixCryptoWasmPkg(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const sourcePkgDir = path.join(
    repoRoot,
    "node_modules",
    "@matrix-org",
    "matrix-sdk-crypto-wasm",
    "pkg",
  );
  const targetPkgDir = path.join(repoRoot, "dist", "pkg");

  removePathIfExists(targetPkgDir);
  if (!fs.existsSync(sourcePkgDir)) {
    return;
  }

  fs.mkdirSync(path.dirname(targetPkgDir), { recursive: true });
  fs.cpSync(sourcePkgDir, targetPkgDir, { force: true, recursive: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyMatrixCryptoWasmPkg();
}
