/**
 * Measure real package-boundary config preparation, including compiler disposal.
 * Run with node --import ./scripts/tsx.mjs scripts/perf/extension-boundary-config-measure.mts
 * [baseline-ref|-] [comma-separated-extension-ids]. Alternate baseline/candidate
 * in fresh processes; use external time for total CPU and peak RSS (including children).
 * This measures preparation, not SDK emission or the whole CI job.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../lib/record-shared.mjs";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : "HEAD";
const sources = new Map<string, string>();
for (const file of [
  "scripts/lib/native-typescript-config.mts",
  "scripts/lib/extension-boundary-projects.mts",
]) {
  sources.set(
    pathToFileURL(path.join(root, file)).href,
    execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, encoding: "utf8" }),
  );
}
const hook = registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module-typescript", shortCircuit: true, source };
  },
});
const { prepareExtensionBoundaryProjects } = await import("../lib/extension-boundary-projects.mts");
const ids = process.argv[3]
  ? process.argv[3].split(",")
  : readdirSync(path.join(root, "extensions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => {
        const file = path.join(root, "extensions", id, "tsconfig.json");
        if (!existsSync(file)) {
          return false;
        }
        const config: unknown = JSON.parse(readFileSync(file, "utf8"));
        return isRecord(config) && config.extends === "../tsconfig.package-boundary.base.json";
      })
      .toSorted();
const started = performance.now();
const projects = prepareExtensionBoundaryProjects(root, ids);
const elapsedMs = performance.now() - started;
const digest = createHash("sha256");
for (const project of projects) {
  digest.update(JSON.stringify(project));
  digest.update(readFileSync(path.join(root, project.config)));
}
console.log(
  JSON.stringify({
    revision,
    projects: projects.length,
    elapsedMs,
    digest: digest.digest("hex"),
    load: loadavg(),
  }),
);
hook.deregister();
