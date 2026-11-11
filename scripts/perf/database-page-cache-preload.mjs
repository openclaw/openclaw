// Optional baseline substitution for the maintenance benchmark and its child readers.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

const directory = process.env.OPENCLAW_BENCH_PAGE_CACHE_OWNER_DIR;
if (directory) {
  const sources = new Map(
    ["sqlite-page-cache.worker.ts", "sqlite-readonly-worker-session.ts"].map((name) => [
      new URL(`../../src/infra/${name}`, import.meta.url).href,
      readFileSync(path.resolve(directory, name), "utf8"),
    ]),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const source = sources.get(url);
      return source === undefined ? loaded : { ...loaded, format: "module-typescript", source };
    },
  });
}
