/**
 * Measure recording real compiler receipts after a full package-boundary check.
 * Run with node --import ./scripts/tsx.mjs scripts/perf/extension-boundary-receipt-measure.mts
 * [baseline-ref|-]. Alternate revisions in fresh processes; compare record digests
 * and use external time for total CPU and peak RSS. This does not measure compilation.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { portableRelativePath } from "../lib/build-artifact-cache.mts";
import { isRecord } from "../lib/record-shared.mjs";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2] ?? "-";
const owner = "scripts/lib/extension-boundary-inputs.mts";
const ownerUrl = pathToFileURL(path.join(root, owner)).href;
const source =
  revision === "-"
    ? undefined
    : execFileSync("git", ["show", `${revision}:${owner}`], { cwd: root, encoding: "utf8" });
const hook = registerHooks({
  load(url, context, nextLoad) {
    return url === ownerUrl && source !== undefined
      ? { format: "module-typescript", shortCircuit: true, source }
      : nextLoad(url, context);
  },
});
const { BoundaryInputSnapshot, BOUNDARY_CACHE_ROOT } =
  await import("../lib/extension-boundary-inputs.mts");
const { prepareExtensionBoundaryProjects } = await import("../lib/extension-boundary-projects.mts");
const directory = path.join(root, BOUNDARY_CACHE_ROOT, "compile");
const ids = fs
  .readdirSync(path.join(root, "extensions"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((id) => {
    const file = path.join(root, "extensions", id, "tsconfig.json");
    if (!fs.existsSync(file)) {
      return false;
    }
    const config: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(config) && config.extends === "../tsconfig.package-boundary.base.json";
  })
  .toSorted();
const missing = ids.filter((id) => !fs.existsSync(path.join(directory, `${id}.inputs.json`)));
if (ids.length === 0 || missing.length > 0) {
  throw new Error("Run the full package-boundary check before measuring its receipts");
}
const projects = prepareExtensionBoundaryProjects(root, ids);
const metadata = projects.flatMap((project) => project.metadataInputs);
const counts = { exists: 0, realpath: 0, nativeRealpath: 0 };
fs.existsSync = new Proxy(fs.existsSync, {
  apply(target, receiver, args) {
    counts.exists++;
    return Reflect.apply(target, receiver, args);
  },
});
fs.realpathSync.native = new Proxy(fs.realpathSync.native, {
  apply(target, receiver, args) {
    counts.nativeRealpath++;
    return Reflect.apply(target, receiver, args);
  },
});
fs.realpathSync = new Proxy(fs.realpathSync, {
  apply(target, receiver, args) {
    counts.realpath++;
    return Reflect.apply(target, receiver, args);
  },
});
const started = performance.now();
const snapshot = new BoundaryInputSnapshot(root, metadata);
const digest = createHash("sha256");
for (const { extensionId, config } of projects) {
  const receipt = path.join(directory, `${extensionId}.inputs.json`);
  const required = [portableRelativePath(root, receipt)];
  const args = [
    path.join(root, "scripts/compile-extension-boundary.mts"),
    JSON.stringify({
      configFile: config,
      inputReceipt: required[0],
      emit: false,
    }),
  ];
  digest.update(extensionId);
  digest.update(JSON.stringify(snapshot.record(config, args, receipt, required)));
}
console.log(
  JSON.stringify({
    revision,
    projects: projects.length,
    elapsedMs: performance.now() - started,
    counts,
    digest: digest.digest("hex"),
    load: loadavg(),
  }),
);
hook.deregister();
