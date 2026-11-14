// Exact owner substitution for the synthetic checkout-picker workload. The manifest
// contains repo-relative source paths frozen with git show, never generated patches.
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";

const source = new URL(import.meta.url).searchParams.get("source");
if (!source) {
  throw new Error("Preload source query must name the frozen synthetic benchmark source");
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const files = JSON.parse(readFileSync(path.join(source, "files.json"), "utf8"));
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
    if (relative === "src/infra/runtime-worker-url.ts") {
      const text = readFileSync(fileURLToPath(url), "utf8");
      const before = '["--import", import.meta.resolve("tsx/esm")]';
      if (!text.includes(before)) {
        throw new Error("Worker preload contract changed");
      }
      return {
        format: "module-typescript",
        source: text.replace(
          before,
          '["--import", import.meta.resolve("tsx/esm"), "--import", ' +
            JSON.stringify(import.meta.url) +
            "]",
        ),
        shortCircuit: true,
      };
    }
    if (!files.includes(relative)) {
      return nextLoad(url, context);
    }
    appendFileSync(
      path.join(source, "loaded.jsonl"),
      JSON.stringify({ threadId, file: relative }) + "\n",
    );
    return {
      format: "module-typescript",
      source: readFileSync(path.join(source, relative), "utf8"),
      shortCircuit: true,
    };
  },
});
