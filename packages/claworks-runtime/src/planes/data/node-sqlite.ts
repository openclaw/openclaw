import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Load Node built-in sqlite (Node 22+). Kept in-package to avoid fork `src/infra` dependency. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}
