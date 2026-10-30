// Isolated benchmark preload: count real production reads without changing the plugin.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const reads = new Map();
const original = fs.readFile;
fs.readFile = function (file, ...args) {
  if (typeof file === "string" && file.startsWith(process.env.WIKI_BENCH_VAULT + path.sep)) {
    const relative = path.relative(process.env.WIKI_BENCH_VAULT, file);
    if (/^(entities|concepts|sources|syntheses|reports)\/.+\.md$/.test(relative)) {
      reads.set(relative, (reads.get(relative) ?? 0) + 1);
    }
  }
  return original.call(this, file, ...args);
};
syncBuiltinESMExports();
process.on("message", (message) => {
  if (message === "wiki-benchmark-reads") {
    process.send?.({ type: "wiki-benchmark-reads", reads: Object.fromEntries(reads) });
    reads.clear();
  }
});
