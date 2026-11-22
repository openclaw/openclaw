import fs from "node:fs";
import path from "node:path";
import { LOCAL_SDK_ROOT } from "./extension-boundary-inputs.mts";

/**
 * The declaration producer owns freshness; reject an unprepared source tree before packaging.
 * @param {string} sourceRoot
 */
export function assertStandaloneSourceBoundaryPrepared(sourceRoot) {
  const declarations = path.join(sourceRoot, LOCAL_SDK_ROOT, "src/plugin-sdk");
  if (
    fs.statSync(declarations, { throwIfNoEntry: false })?.isDirectory() &&
    fs.readdirSync(declarations).some((name) => /\.d\.[cm]?ts$/u.test(name))
  ) {
    return;
  }
  throw new Error(
    `Original-source AOT needs the package-boundary declarations in ${LOCAL_SDK_ROOT}. ` +
      "Prepare them before building: " +
      "node --import ./scripts/tsx.mjs scripts/prepare-extension-package-boundary-artifacts.mts",
  );
}
