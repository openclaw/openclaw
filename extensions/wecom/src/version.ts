import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Searches upward from the current file location to find package.json
 * - When running ts source directly (tsx/ts-node): src/version.ts -> 1 level up
 * - When running tsc-compiled output: dist/src/version.js -> 2 levels up
 */
const findPackageJson = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    } // Reached filesystem root
    dir = parent;
  }
  throw new Error("Cannot find package.json");
};

const pkg = JSON.parse(readFileSync(findPackageJson(), "utf-8")) as { version: string };

/** Plugin version, read from package.json at runtime */
export const PLUGIN_VERSION: string = pkg.version ?? "";
