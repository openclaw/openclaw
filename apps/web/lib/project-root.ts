import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT_MARKER = join("assets", "seed", "workspace.duckdb");

/** Monorepo / DenchClaw package root (has assets/seed/workspace.duckdb). */
export function resolveDenchPackageRoot(): string | null {
  let dir = process.cwd();
  for (let index = 0; index < 10; index += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, ROOT_MARKER))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}
