/**
 * Measure a full current-tree inventory with the selected credential analyzer.
 * Run in fresh processes, alternating frozen baseline/candidate refs:
 * node --import ./scripts/tsx.mjs scripts/perf/database-worker-inventory-measure.mts <ref>
 * Use external time for total CPU and peak RSS, including the native compiler.
 * --count-walks instruments visits; keep those runs separate from timing samples.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeTypeScriptObserver } from "../lib/native-typescript.mts";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : "HEAD";
const countWalks = process.argv.includes("--count-walks");
const file = "scripts/lib/personal-credential-writer-guard.mts";
const url = pathToFileURL(path.join(root, file)).href;
let source = execFileSync("git", ["show", `${revision}:${file}`], {
  cwd: root,
  encoding: "utf8",
});
if (countWalks) {
  source =
    "export let measuredNodeVisits = 0;\n" +
    source.replaceAll(
      "const visit = (node: ts.Node) => {",
      "const visit = (node: ts.Node) => { measuredNodeVisits++;",
    );
}
const hook = registerHooks({
  load(requested, context, nextLoad) {
    return requested === url
      ? { format: "module-typescript", shortCircuit: true, source }
      : nextLoad(requested, context);
  },
});
const { inventory, loadInventorySources } = await import("../database-worker-inventory.mjs");
const phases: { phase: string; facts: Parameters<NativeTypeScriptObserver>[1] }[] = [];
const sources = loadInventorySources(root);
const inputs = createHash("sha256");
for (const entry of sources) {
  inputs.update(JSON.stringify(entry));
}
const started = performance.now();
const rows = inventory(root, "", false, sources, {
  observer(phase, facts) {
    phases.push({ phase, facts });
  },
});
const elapsedMs = performance.now() - started;
let nodeVisits: number | undefined;
if (countWalks) {
  const measured: unknown = await import(url);
  if (typeof measured === "object" && measured !== null && "measuredNodeVisits" in measured) {
    nodeVisits = Number(measured.measuredNodeVisits);
  }
}
console.log(
  JSON.stringify({
    revision,
    sources: sources.size,
    inputDigest: inputs.digest("hex"),
    rows: rows.length,
    digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    elapsedMs,
    nodeVisits,
    load: loadavg(),
    phases,
  }),
);
hook.deregister();
