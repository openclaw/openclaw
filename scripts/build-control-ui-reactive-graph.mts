import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildControlUiReactiveGraph } from "./lib/control-ui-reactive-graph.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
if (!values["out-dir"]) {
  throw new Error("Provide --out-dir under .artifacts for this diagnostic-only build");
}
await buildControlUiReactiveGraph({
  repoRoot: fileURLToPath(new URL("..", import.meta.url)),
  outDir: path.resolve(values["out-dir"]),
});
